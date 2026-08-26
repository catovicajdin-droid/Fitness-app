const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret, defineString } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const { GarminConnect } = require("garmin-connect");

const garminEmail = defineSecret("GARMIN_EMAIL");
const garminPassword = defineSecret("GARMIN_PASSWORD");
const allowedUid = defineString("ALLOWED_UID");

// Kept low deliberately: this app only ever has 36 workouts total, so a
// realistic bulk send is a handful of weeks (a few payloads), never
// anywhere near this cap. It exists to bound worst-case function runtime
// (see FUNCTION_TIMEOUT_SECONDS below) and cost exposure, not to support
// large batches.
const MAX_PAYLOADS_PER_CALL = 12;
const MIN_DELAY_MS = 500;
const MAX_DELAY_MS = 10000;
const SESSION_MAX_AGE_MS = 25 * 60 * 1000;

// Worst case: MAX_PAYLOADS_PER_CALL payloads, each waiting MAX_DELAY_MS,
// plus real Garmin request time per payload and a possible re-login.
// Keep this comfortably above that so the function is never killed
// mid-batch, and keep the client's callable timeout (in index.html) at
// least this high too, or the client gives up before the server does.
const FUNCTION_TIMEOUT_SECONDS = 240;

let cachedClient = null;
let cachedClientAt = 0;

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function getGarminClient({ forceLogin }) {
  const isFresh =
    cachedClient && Date.now() - cachedClientAt < SESSION_MAX_AGE_MS;

  if (cachedClient && isFresh && !forceLogin) {
    return cachedClient;
  }

  const client = new GarminConnect({
    username: garminEmail.value(),
    password: garminPassword.value()
  });

  await client.login();

  cachedClient = client;
  cachedClientAt = Date.now();

  return cachedClient;
}

function isAuthError(error) {
  const status =
    error && error.response && error.response.status;

  return status === 401 || status === 403;
}

async function sendOnePayload(payload) {
  let client;

  try {
    client = await getGarminClient({ forceLogin: false });
    return await client.addWorkout(payload);
  } catch (error) {
    if (!isAuthError(error)) {
      throw error;
    }

    logger.warn(
      "Garmin session looked stale, retrying with a fresh login.",
      { message: error.message }
    );

    client = await getGarminClient({ forceLogin: true });
    return await client.addWorkout(payload);
  }
}

// The core handler is a plain function so it can be exercised directly in
// tests (with a fake `request` and an injected `sendOnePayload`) without
// needing real Garmin credentials, network access, or the Functions runtime.
async function handleSendWorkoutToGarmin(request, deps = {}) {
  const send = deps.sendOnePayload || sendOnePayload;
  const getAllowedUid = deps.getAllowedUid || (() => allowedUid.value());

  if (!request.auth) {
    throw new HttpsError(
      "unauthenticated",
      "Sign in before sending workouts to Garmin."
    );
  }

  if (request.auth.uid !== getAllowedUid()) {
    throw new HttpsError(
      "permission-denied",
      "This account is not allowed to use this function."
    );
  }

  const payloads = request.data && request.data.payloads;

  if (!Array.isArray(payloads) || payloads.length === 0) {
    throw new HttpsError(
      "invalid-argument",
      "Provide at least one workout payload."
    );
  }

  if (payloads.length > MAX_PAYLOADS_PER_CALL) {
    throw new HttpsError(
      "invalid-argument",
      `Send at most ${MAX_PAYLOADS_PER_CALL} workouts per call.`
    );
  }

  const requestedDelay = Number(request.data.delayMs);

  const delayMs = Number.isFinite(requestedDelay)
    ? Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, requestedDelay))
    : MIN_DELAY_MS;

  const results = [];

  for (const payload of payloads) {
    const workoutName =
      (payload && payload.workoutName) || "Untitled workout";

    try {
      await send(payload);

      results.push({ name: workoutName, status: "created" });

      logger.info("Created Garmin workout", { workoutName });
    } catch (error) {
      results.push({
        name: workoutName,
        status: "failed",
        error: error.message || "Unknown error"
      });

      logger.error("Failed to create Garmin workout", {
        workoutName,
        message: error.message
      });
    }

    if (payloads.length > 1) {
      await sleep(delayMs);
    }
  }

  return { results };
}

exports.handleSendWorkoutToGarmin = handleSendWorkoutToGarmin;

exports.sendWorkoutToGarmin = onCall(
  {
    region: "europe-west1",
    secrets: [garminEmail, garminPassword],
    timeoutSeconds: FUNCTION_TIMEOUT_SECONDS,
    memory: "256MiB",
    // This is a single-user, manually-triggered app -- there is never a
    // legitimate reason for more than one or two invocations running at
    // once. Keeping this low bounds worst-case concurrent cost exposure
    // even if the endpoint were ever called in a way it shouldn't be
    // (the ALLOWED_UID check is the real guard against that; this is a
    // second layer, not a substitute for it).
    maxInstances: 2
  },
  request => handleSendWorkoutToGarmin(request)
);
