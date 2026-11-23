import { sendMessage } from "@/lib/chat";
import { readJson, noStore } from "../_body";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// { token, text } → Sitara's reply
export async function POST(req: Request) {
  const body = await readJson(req);
  const result = await sendMessage(String(body.token ?? ""), String(body.text ?? ""));
  const status = result.ok ? 200 : result.error === "invalid_token" ? 404 : 409;
  return Response.json(result, { ...noStore, status });
}
