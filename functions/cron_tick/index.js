// Catalyst Cron function. The schedule (every minute) is created in the Catalyst console and points at this function.
// It only rings the doorbell: the real work, and all the safety checks, happen in the core API's job route.
module.exports = async (cronDetails, context) => {
  const url = process.env.DOZAI_TICK_URL;
  const token = process.env.DOZAI_JOB_TOKEN;
  if (!url || !token) {
    console.log("cron_tick: DOZAI_TICK_URL or DOZAI_JOB_TOKEN is not set");
    context.closeWithFailure();
    return;
  }
  try {
    const res = await fetch(url, { method: "POST", headers: { "x-job-token": token } });
    const body = await res.text();
    console.log("cron_tick", res.status, body.slice(0, 300)); // counts and case ids only, no personal data
    if (res.ok) context.closeWithSuccess(); else context.closeWithFailure();
  } catch (e) {
    console.log("cron_tick failed:", e.message);
    context.closeWithFailure();
  }
};
