import { Context } from 'hono';
import { DataProvider } from '../../../enum';
import { Strings } from '../../../strings';
import { handleActivity } from '../../../embed/activity';

/* Discord reads this, not the OpenGraph tags — see Experiment.ACTIVITY_EMBED. */
export const activityRequest = async (c: Context) => {
  const { snowcode } = c.req.param();

  const statusResponse = await handleActivity(c, snowcode ?? '0', DataProvider.Mastodon);

  if (statusResponse) {
    c.status(200);
    return statusResponse;
  }
  return c.text(Strings.ERROR_UNKNOWN, 500);
};
