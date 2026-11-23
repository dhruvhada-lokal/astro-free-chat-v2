import { nudge } from "@/lib/chat";
import { readJson, noStore } from "../_body";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// { token } → Sitara carries on after the user has been quiet (the server checks the silence itself)
export async function POST(req: Request) {
  const body = await readJson(req);
  const result = await nudge(String(body.token ?? ""));
  const status = result.ok ? 200 : result.error === "invalid_token" ? 404 : 409;
  return Response.json(result, { ...noStore, status });
}
