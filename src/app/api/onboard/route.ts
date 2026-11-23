import { submitDob } from "@/lib/chat";
import { readJson, noStore } from "../_body";

export const dynamic = "force-dynamic";

// { token, name?, dob } → saves dob onto that real user_id's own account (needs_dob screen only) and opens the chat.
export async function POST(req: Request) {
  const body = await readJson(req);
  const { ok, view } = await submitDob(String(body.token ?? ""), body);
  return Response.json({ ok, view }, { ...noStore, status: view.status === "invalid" ? 404 : 200 });
}
