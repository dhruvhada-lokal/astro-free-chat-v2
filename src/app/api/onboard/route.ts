import { getStore } from "@/lib/store";
import { buildSelfServeUser } from "@/lib/onboard";
import { readJson, noStore } from "../_body";

export const dynamic = "force-dynamic";

// { name, gender?, dob, tob?, pob } → builds a chart-ready user (cohort: self_serve) and returns its token.
// The browser then opens /c/<token>, which shows the language picker (chat_language is unset), same as any
// other first-time chat.
export async function POST(req: Request) {
  const body = await readJson(req);
  const result = buildSelfServeUser(body);
  if (!result.ok) return Response.json(result, { ...noStore, status: 400 });
  await getStore().upsertUsers([result.user]);
  return Response.json({ ok: true, token: result.user.token }, noStore);
}
