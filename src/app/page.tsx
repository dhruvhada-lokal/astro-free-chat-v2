import { randomBytes } from "node:crypto";
import Chat from "./c/[token]/Chat";

export const dynamic = "force-dynamic";

export default function Home() {
  // Generate a temporary token that cannot collide with an existing user.
  // The onboarding API creates the real user and token.
  const onboardingToken = randomBytes(18).toString("hex");

  return <Chat token={onboardingToken} />;
}
