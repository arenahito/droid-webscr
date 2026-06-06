import { runAndroidEmulatorVerification } from "./android-emulator-verify-lib.mjs";

const result = await runAndroidEmulatorVerification();
console.log(
  `android:emulator:verify completed HELLO, video, and control verification with ${result.serial} on tcp:${result.forwardedPort}.`,
);
