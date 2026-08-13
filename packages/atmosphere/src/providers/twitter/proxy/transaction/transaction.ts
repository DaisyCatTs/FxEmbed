import { Cubic } from './cubic.js';
import { isOdd, interpolate, convertRotationToMatrix, floatToHex } from './utils.js';
import { parseHomePageSignals, parseMigrationPage, type HomePageSignals } from './html.js';

import { NetPolicies, guardedFetch } from '../../../../net/index.js';

/* Outbound requests go through the shared guard: host allowlist, https-only,
   redirect re-validation, timeout and a response size ceiling. */
const xFetch = (input: string | URL | Request, init: RequestInit = {}) =>
  guardedFetch(input, init, {
    hostPolicy: NetPolicies.twitterApi,
    signal: init.signal ?? undefined
  });

// Cached fetch helper that uses Cloudflare Worker cache
async function cachedFetch(
  input: RequestInfo,
  init?: RequestInit,
  fetchNew = false
): Promise<Response> {
  const startTime = performance.now();
  const request = new Request(fetchNew ? input + `?${Math.random()}` : input, init);
  // @ts-expect-error caches may be absent in non-Worker contexts
  const cache = globalThis.caches?.default;
  if (!fetchNew && cache) {
    const cachedResponse = await cache.match(request);
    if (cachedResponse) {
      const endTime = performance.now();
      console.log(`Cache hit for ${input} in ${endTime - startTime}ms`);
      return cachedResponse.clone();
    }
  }
  const response = await xFetch(request);
  if (request.method === 'GET' && response.ok) {
    const endTime = performance.now();
    console.log(`Cache miss for ${input} in ${endTime - startTime}ms`);
    const clonedResponse = response.clone();
    const cacheHeaders = new Headers();
    cacheHeaders.set('cache-control', `public, max-age=300`);
    const newResponse = new Response(clonedResponse.body, {
      status: clonedResponse.status,
      statusText: clonedResponse.statusText,
      headers: cacheHeaders
    });
    const cacheRequest = new Request(input, init);
    if (cache) {
      await cache.put(cacheRequest, newResponse);
    }
  }
  return response;
}

/**
 * Handle X.com migration (refresh meta and form-based redirect).
 *
 * Returns the raw HTML of the final page reached.
 */
export async function handleXMigration(fetchNewHomePage = false): Promise<string> {
  const homeUrl = 'https://x.com/home';
  let resp = await cachedFetch(
    homeUrl,
    {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36'
      }
    },
    fetchNewHomePage
  );
  let html = await resp.text();
  let page = await parseMigrationPage(html);

  if (page.migrationUrl) {
    resp = await cachedFetch(page.migrationUrl);
    html = await resp.text();
    page = await parseMigrationPage(html);
  }

  const form = page.form;
  if (form) {
    if (form.method === 'GET') {
      const url = form.action + '?' + new URLSearchParams(form.fields).toString();
      resp = await cachedFetch(url);
    } else {
      const body = new URLSearchParams(form.fields).toString();
      resp = await cachedFetch(form.action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body
      });
    }
    html = await resp.text();
  }

  return html;
}

const ON_DEMAND_FILE_REGEX = /,(\d+):["']ondemand\.s["']/;
const ON_DEMAND_HASH_PATTERN = (index: string) => new RegExp(`,${index}:"([0-9a-f]+)"`);
const INDICES_REGEX = /\(\w\[(\d{1,2})\],\s*16\)/g;

export class ClientTransaction {
  private homePageHtml: string;
  private signals: HomePageSignals;
  private defaultRowIndex!: number;
  private defaultKeyBytesIndices!: number[];
  private key!: string;
  private keyBytes!: number[];
  private animationKey!: string;

  static ADDITIONAL_RANDOM_NUMBER = 3;
  static DEFAULT_KEYWORD = 'obfiowerehiring';

  private constructor(homePageHtml: string, signals: HomePageSignals) {
    this.homePageHtml = homePageHtml;
    this.signals = signals;
  }

  static async create(fetchNewHomePage = false): Promise<ClientTransaction> {
    if (fetchNewHomePage) {
      console.log(`Let's try fetching the home page again`);
    }
    const html = await handleXMigration(fetchNewHomePage);
    const tx = new ClientTransaction(html, await parseHomePageSignals(html));
    await tx.init();
    return tx;
  }

  private async init(): Promise<void> {
    const [rowIndex, keyIndices] = await this.getIndices();
    this.defaultRowIndex = rowIndex;
    this.defaultKeyBytesIndices = keyIndices;
    this.key = this.getKey();
    this.keyBytes = this.getKeyBytes(this.key);
    this.animationKey = this.getAnimationKey();
    console.log('Animation key:', this.animationKey);
  }

  private async getIndices(): Promise<[number, number[]]> {
    const html = this.homePageHtml;
    const indexMatch = ON_DEMAND_FILE_REGEX.exec(html);
    if (!indexMatch?.[1]) {
      throw new Error("Couldn't get on-demand file index");
    }
    const hashMatch = ON_DEMAND_HASH_PATTERN(indexMatch[1]).exec(html);
    if (!hashMatch?.[1]) {
      throw new Error("Couldn't get on-demand file hash");
    }
    const hash = hashMatch[1];
    const url = `https://abs.twimg.com/responsive-web/client-web/ondemand.s.${hash}a.js`;
    const resp = await cachedFetch(url);
    const text = await resp.text();
    const indices: number[] = [];
    let match: RegExpExecArray | null;
    INDICES_REGEX.lastIndex = 0;
    while ((match = INDICES_REGEX.exec(text)) !== null) {
      indices.push(parseInt(match[1], 10));
    }
    if (indices.length < 2) {
      throw new Error("Couldn't get KEY_BYTE indices");
    }
    console.log(`Indices: ${indices}`);
    return [indices[0], indices.slice(1)];
  }

  private getKey(): string {
    const content = this.signals.key;
    if (!content) {
      throw new Error("Couldn't get key from the page source");
    }
    console.log(`Key: ${content}`);
    return content;
  }

  private getKeyBytes(key: string): number[] {
    const binary = atob(key);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return Array.from(bytes);
  }

  private get2dArray(): number[][] {
    const idx = this.keyBytes[5] % 4;
    const d = this.signals.framePaths[idx];
    if (!d) {
      throw new Error("Couldn't find path 'd' attribute");
    }
    return d
      .slice(9)
      .split('C')
      .map(item =>
        item
          .replace(/[^\d]+/g, ' ')
          .trim()
          .split(/\s+/)
          .map(n => parseInt(n, 10))
      );
  }

  private solve(value: number, minVal: number, maxVal: number, rounding: boolean): number {
    const res = (value * (maxVal - minVal)) / 255 + minVal;
    return rounding ? Math.floor(res) : parseFloat(res.toFixed(2));
  }

  private animate(frames: number[], targetTime: number): string {
    const fromColor = [...frames.slice(0, 3).map(v => v), 1];
    const toColor = [...frames.slice(3, 6).map(v => v), 1];
    const toRot = [this.solve(frames[6], 60, 360, true)];
    const curves = frames.slice(7).map((v, i) => this.solve(v, isOdd(i), 1, false));
    const cubic = new Cubic(curves);
    const f = cubic.getValue(targetTime);
    const color = interpolate(fromColor, toColor, f).map(v => Math.max(0, Math.min(255, v)));
    const rot = interpolate([0], toRot, f);
    const matrix = convertRotationToMatrix(rot[0]);

    const hexArr: string[] = [];
    color.slice(0, -1).forEach(v => hexArr.push(Math.round(v).toString(16)));
    matrix.forEach(val => {
      let rv = parseFloat(val.toFixed(2));
      if (rv < 0) rv = -rv;
      const hx = floatToHex(rv);
      if (hx.startsWith('.')) {
        hexArr.push(('0' + hx).toLowerCase());
      } else if (hx) {
        hexArr.push(hx.toLowerCase());
      } else {
        hexArr.push('0');
      }
    });
    hexArr.push('0', '0');
    return hexArr.join('').replace(/[.-]/g, '');
  }

  private getAnimationKey(): string {
    const total = 4096;
    const rowIndex = this.keyBytes[this.defaultRowIndex] % 16;
    let frameTime = this.defaultKeyBytesIndices
      .map(i => this.keyBytes[i] % 16)
      .reduce((a, b) => a * b, 1);
    frameTime = Math.round(frameTime / 10) * 10;
    const grid = this.get2dArray();
    const row = grid[rowIndex];
    const t = frameTime / total;
    return this.animate(row, t);
  }

  async generateTransactionId(method: string, path: string): Promise<string> {
    const now = Math.floor(Date.now() / 1000 - 1682924400);
    const timeBytes = [0, 1, 2, 3].map(i => (now >> (i * 8)) & 0xff);
    const hashInput = `${method}!${path}!${now}${ClientTransaction.DEFAULT_KEYWORD}${this.animationKey}`;

    const encoder = new TextEncoder();
    const data = encoder.encode(hashInput);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const fullHash = new Uint8Array(hashBuffer);
    const hashBytes = Array.from(fullHash.slice(0, 16));
    const rnd = Math.floor(Math.random() * 256);
    const arr = [
      ...this.keyBytes,
      ...timeBytes,
      ...hashBytes.slice(0, 16),
      ClientTransaction.ADDITIONAL_RANDOM_NUMBER
    ];
    const xored = arr.map(x => x ^ rnd);
    const outBytes = new Uint8Array([rnd, ...xored]);
    let binary = '';
    outBytes.forEach(b => (binary += String.fromCharCode(b)));
    const base64 = btoa(binary);
    return base64.replace(/=+$/, '');
  }
}
