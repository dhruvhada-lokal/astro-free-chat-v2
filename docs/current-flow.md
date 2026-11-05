# How Omkar works right now (free_chat_v4.2 + unreleased push-for-answer redesign)

This is the current, live behavior, end to end. For the history of how we got here, see
`CHANGELOG.md`, `changes-before-prompt-rewrite.md`, and `changes-after-prompt-rewrite.md`.

## 1. Chat opens (scripted, no AI call)

"Namaste {name} ji 🙏" / "Aapka swagat hai." (or "Kaise hai aap?" if we already know their topic).
The 120-second clock starts the moment the page opens.

## 2. If they stay silent

At 7.5s, "typing…" shows. At 10s, Omkar asks the topic himself — their known topic question, or the
generic one. Fires once only, and never if they've already said anything.

## 3. Stage "gather" — their first real message

If it already names a topic AND their specific situation, Omkar skips straight to a real answer
(see step 4). Otherwise he asks ONE short, topic-specific follow-up (e.g. "Naukri mein abhi kya
dikkat hai?"). **Only one such round is allowed** — the next reply is always forced into a real
answer, whether or not the follow-up actually got a useful reply.
- If the model fails here, the fallback is a real topic-specific follow-up (`topic_followup`), not
  the generic "do you want to know about X?" line — and never repeats a line already said.

## 4. Stage "answer" — the real first finding

Forced the first time Omkar gives a finding. The reveal:
```
Aapki kundli dekh raha hoon…          (scripted, ~1s typing)
[kundli card]                          (5s silence + 2.5s typing = 7.5s total)
Dasha Mangal chal rahi hai.            (scripted, plain — no positive spin added)
[bubble 1: ONE chart detail, present-continuous tense, tied to what they said]
[bubble 2: a hedged, hopeful forward-looking line]
```
Direct, two-bubble answer style — gives a real (if hedged) answer, not a withheld "finding."

## 5. Stage "engage" — every turn after that

Reacts to what they said, adds one new insight. This is where question-asking and the
"push for the answer" behavior live — see section 6 below.

## 6. Pushing for the answer (new, three-case design)

`engage` now has its own dedicated, one-time question allowance — **independent of whether
`gather` used its own** (this was a real bug: with a shared budget, `gather` skipping its question
used to leave room for `engage` to ask twice). Tracked by `SessionState.engageQuestionUsed`.

- **Case A — first push, question still available** (`ask_yes`): acknowledge, then ask ONE real
  follow-up ending in "?", framed as needing to understand their situation better. Not a random
  question — specifically useful if they're pushing. If they aren't pushing, a plain personal
  question is fine too. This uses up `engage`'s one-and-only question, forever, for this chat.
- **Case B — they answer that follow-up, question now gone** (`ask_no`): don't resolve anything.
  Acknowledge the *specific* thing they just said, then end with a standalone line naming whatever
  keeps recurring for them, followed by exactly **"ke peeche ek wajah hai…"** (trailing off with
  "…", nothing more, no explanation of what the reason is).
- **Case C — they push again after that** (`push_wait`, fires once the engine has seen the Case B
  line go out — `SessionState.pushHintGiven`): still don't resolve it, and never repeat the Case B
  line. Two bubbles: first, "I'm still looking closely at that" in Omkar's own words; second, one
  positive-leaning line that stops dead **mid-word** on "agar" or "magar" — no ellipsis, no
  punctuation, genuinely unfinished. This is the one exception to "always a complete sentence."

**Important caveat** (see the Q&A above): whether the user is "pushing" at all is a judgment call
left to the model — there's no code-level push-detector yet. `ask_yes`/`ask_no`/`push_wait` are
chosen deterministically by the engine (based on question/cliffhanger state), but *applying* the
push-specific behavior inside each one is still the model's own read of the conversation.

Outside of a push, `engage` behaves normally: one new insight per turn, max 3 bubbles early on,
2-3 later, never a repeated line or opening.

## 7. Stage "hook" (last ~40 seconds)

No new insights — one open thread about THEIR actual question, left deliberately unfinished. Two
short bubbles (4-7 words each).

## 8. Quiet

If they go silent for 25s mid-chat, Omkar continues on his own, like he's still reading.

## 9. If the model call fails or times out

`llm_timeout_ms: 18000` (real latency typically 10-17s). A failed/timed-out call:
- In "gather": the topic-specific follow-up fallback, never repeating a line already said.
- Anywhere else: `fallback_reply`; a second failure swaps to `fallback_reply_alt` instead of
  repeating. A failed "answer" stage call still moves the chat forward (`st.answered = true`) —
  it can never get stuck retrying "answer" forever.
- **Time spent waiting on the model never costs the user clock time** — `SessionState.llmWaitMs`
  is excluded from the free-chat countdown, so a slow/failed call doesn't eat into their 120s.

## 10. Safety nets, always on (code, not just prompt wording)

- Never two astrology terms in one bubble ("Shani aur Ketu ka asar") — dropped automatically.
- Never the wrong rashi/dasha/antardasha for this specific person.
- Never a repeated line, a banned word (dates, remedies, price, fear, guarantees), a too-long
  bubble, or more questions than the budget allows.

## What changed recently vs. what's untouched

**Reverted back to the original (pre-rewrite) style**: `prompt_template.md`'s skeleton (the user's
own new FLOW-based version is now the live prompt, replacing both the original AND the "findings
not the answer" rewrite we tried in between), direct hedged-answer tone in `answer`/`gather`,
`insight_levels` saying "give an answer."

**New, built on top of the current prompt**: the entire Case A/B/C push-for-answer design
(section 6) — this did not exist before this round of work, and needed real engine state
(`engageQuestionUsed`, `pushHintGiven`) because prompt wording alone couldn't keep the three cases
from blending into each other.

**Kept from the whole session's bug-fixing, regardless of which prompt is active**: the gather
clarify-round cap, the gather-fallback topic preference and no-repeat guarantee, the "bacche"
keyword fix, the stacked-terms guard, the "answer" stage stuck-loop fix, `fallback_reply_alt`,
`topic_followup`, and the `llmWaitMs` clock-drain fix.

## What's still open / not yet decided

- No engine-level detection of "the user is pushing" — currently model judgment only (see above).
- `question_budget: 2` (the old gather+engage shared ceiling) is now mostly vestigial for `engage`'s
  own gating (replaced by `engageQuestionUsed`), but still exists as `guardReply`'s backstop against
  a runaway number of questions — worth revisiting if it ever causes confusion.
