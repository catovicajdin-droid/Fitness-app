// Standalone sanity test for handleSendWorkoutToGarmin's logic, run with
// plain `node functions/test-handler.js`. Exercises auth checks, input
// validation, delay clamping, and per-item success/failure reporting with
// a fake sendOnePayload so it needs no real Garmin credentials or network
// access, neither of which this sandbox can reach anyway.
const assert = require("assert");
const { handleSendWorkoutToGarmin } = require("./index.js");

const ALLOWED_UID = "owner-uid";

function baseRequest(overrides = {}) {
  return {
    auth: { uid: ALLOWED_UID },
    data: { payloads: [{ workoutName: "Week 1 - Monday" }] },
    ...overrides
  };
}

async function expectHttpsError(promise, code) {
  try {
    await promise;
  } catch (error) {
    assert.strictEqual(error.code, code, `expected code ${code}, got ${error.code}: ${error.message}`);
    return;
  }
  throw new Error(`expected an HttpsError with code ${code}, but the call succeeded`);
}

async function run() {
  const deps = { getAllowedUid: () => ALLOWED_UID };

  // 1. Unauthenticated caller is rejected.
  await expectHttpsError(
    handleSendWorkoutToGarmin({ auth: null, data: {} }, deps),
    "unauthenticated"
  );
  console.log("PASS: unauthenticated caller rejected");

  // 2. Authenticated but wrong uid is rejected.
  await expectHttpsError(
    handleSendWorkoutToGarmin(
      baseRequest({ auth: { uid: "someone-else" } }),
      deps
    ),
    "permission-denied"
  );
  console.log("PASS: wrong uid rejected");

  // 3. Empty payloads array rejected.
  await expectHttpsError(
    handleSendWorkoutToGarmin(baseRequest({ data: { payloads: [] } }), deps),
    "invalid-argument"
  );
  console.log("PASS: empty payloads rejected");

  // 4. Non-array payloads rejected.
  await expectHttpsError(
    handleSendWorkoutToGarmin(
      baseRequest({ data: { payloads: "not-an-array" } }),
      deps
    ),
    "invalid-argument"
  );
  console.log("PASS: non-array payloads rejected");

  // 5. Too many payloads rejected.
  const tooMany = Array.from({ length: 21 }, (_, i) => ({
    workoutName: `Workout ${i}`
  }));
  await expectHttpsError(
    handleSendWorkoutToGarmin(baseRequest({ data: { payloads: tooMany } }), deps),
    "invalid-argument"
  );
  console.log("PASS: over-limit payload count rejected");

  // 6. Successful single send calls sendOnePayload once and reports "created".
  {
    const calls = [];
    const result = await handleSendWorkoutToGarmin(baseRequest(), {
      ...deps,
      sendOnePayload: async payload => {
        calls.push(payload);
        return { ok: true };
      }
    });

    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(result.results, [
      { name: "Week 1 - Monday", status: "created" }
    ]);
  }
  console.log("PASS: successful single send reports created");

  // 7. Mixed success/failure across multiple payloads is reported per item,
  //    and one failure doesn't abort the remaining sends.
  {
    const names = [];
    const request = baseRequest({
      data: {
        payloads: [
          { workoutName: "Week 1 - Monday" },
          { workoutName: "Week 1 - Wednesday" },
          { workoutName: "Week 1 - Friday" }
        ],
        delayMs: 1 // keep the test fast; clamped up to MIN_DELAY_MS internally
      }
    });

    const result = await handleSendWorkoutToGarmin(request, {
      ...deps,
      sendOnePayload: async payload => {
        names.push(payload.workoutName);
        if (payload.workoutName === "Week 1 - Wednesday") {
          throw new Error("Garmin rejected this workout");
        }
        return { ok: true };
      }
    });

    assert.deepStrictEqual(names, [
      "Week 1 - Monday",
      "Week 1 - Wednesday",
      "Week 1 - Friday"
    ]);
    assert.deepStrictEqual(result.results, [
      { name: "Week 1 - Monday", status: "created" },
      {
        name: "Week 1 - Wednesday",
        status: "failed",
        error: "Garmin rejected this workout"
      },
      { name: "Week 1 - Friday", status: "created" }
    ]);
  }
  console.log("PASS: mixed success/failure reported per item, all attempted");

  console.log("\nAll handler tests passed.");
}

run().catch(error => {
  console.error("TEST FAILURE:", error);
  process.exit(1);
});
