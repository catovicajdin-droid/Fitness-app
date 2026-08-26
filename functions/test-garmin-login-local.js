// Standalone diagnostic: logs into Garmin and creates one clearly-labeled
// test workout, using the exact same garmin-connect client and addWorkout()
// call the deployed Cloud Function uses. Run this from your own computer
// (not from the sandbox, not deployed) to check whether login/workout
// creation succeeds from your home IP -- if it does here but the deployed
// Cloud Function keeps getting 429'd, that points at Google Cloud's IP
// range being rate-limited by Garmin, not your account or the code.
//
// Usage (from the functions/ folder, after `npm install`):
//   set GARMIN_EMAIL=you@example.com
//   set GARMIN_PASSWORD=yourpassword
//   node test-garmin-login-local.js
//
// Credentials are read from environment variables only -- never hardcode
// them into this file.
const { GarminConnect } = require("garmin-connect");

async function main() {
  const email = process.env.GARMIN_EMAIL;
  const password = process.env.GARMIN_PASSWORD;

  if (!email || !password) {
    console.error(
      "Set GARMIN_EMAIL and GARMIN_PASSWORD environment variables first (see the comment at the top of this file)."
    );
    process.exit(1);
  }

  console.log("Logging in as", email, "...");

  const client = new GarminConnect({ username: email, password });

  try {
    await client.login();
    console.log("Login succeeded.");
  } catch (error) {
    console.error("Login FAILED:", error.message);
    process.exit(1);
  }

  const testPayload = {
    sportType: {
      sportTypeId: 5,
      sportTypeKey: "strength_training",
      displayOrder: 5
    },
    workoutName: "Claude Diagnostic Test - safe to delete",
    workoutSegments: [
      {
        segmentOrder: 1,
        sportType: {
          sportTypeId: 5,
          sportTypeKey: "strength_training",
          displayOrder: 5
        },
        workoutSteps: [
          {
            stepId: 1,
            stepOrder: 1,
            stepType: {
              stepTypeId: 1,
              stepTypeKey: "warmup",
              displayOrder: 1
            },
            type: "ExecutableStepDTO",
            description: "Diagnostic test step - delete this workout.",
            endCondition: {
              conditionTypeId: 2,
              conditionTypeKey: "time",
              displayOrder: 2,
              displayable: true
            },
            endConditionValue: 30,
            targetType: {
              workoutTargetTypeId: 1,
              workoutTargetTypeKey: "no.target",
              displayOrder: 1
            }
          }
        ]
      }
    ],
    estimatedDurationInSecs: 30,
    estimatedDistanceInMeters: 0,
    isWheelchair: false
  };

  console.log("Attempting to create the test workout...");

  try {
    await client.addWorkout(testPayload);
    console.log(
      "SUCCESS: workout created. Check Garmin Connect Workouts for " +
        '"Claude Diagnostic Test - safe to delete" and delete it once confirmed.'
    );
  } catch (error) {
    console.error("Workout creation FAILED:", error.message);
    process.exit(1);
  }
}

main();
