/** Which upstream network a status or API path targets. */
export enum DataProvider {
  Twitter = 'twitter',
  Bluesky = 'bluesky',
  TikTok = 'tiktok',
  Mastodon = 'mastodon',
  Instagram = 'instagram',
  /* Matches the `provider` literal the Threads processor already stamps onto every status it
     builds; the enum simply had no member for it until Threads gained an embed pipeline. */
  Threads = 'threads'
}
