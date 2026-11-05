import { chooseLanguage } from "@/lib/chat";
import { readJson, noStore } from "../_body";

export const dynamic = "force-dynamic";

// { token, language } → saves the pick (if not already set) and opens the chat in that language.
export async function POST(req: Request) {
  const body = await readJson(req);
  const view = await chooseLanguage(String(body.token ?? ""), String(body.language ?? ""));
  return Response.json(view, { ...noStore, status: view.status === "invalid" ? 404 : 200 });
}
