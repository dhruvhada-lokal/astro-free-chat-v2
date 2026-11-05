import { topicPrompt } from "@/lib/chat";
import { readJson, noStore } from "../_body";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// { token } → the proactive topic question, once the post-greeting pause has passed with nothing said
// (timing.topic_wait_seconds). Scripted, no model call; the server checks eligibility itself.
export async function POST(req: Request) {
  const body = await readJson(req);
  const result = await topicPrompt(String(body.token ?? ""));
  const status = result.ok ? 200 : result.error === "invalid_token" ? 404 : 409;
  return Response.json(result, { ...noStore, status });
}
