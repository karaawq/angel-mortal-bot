import { Api, Bot, GrammyError, type Context } from "grammy";
import type { Message, MessageEntity } from "grammy/types";
import { parseAdminIds } from "./config";
import { Db, type Participant, type Role } from "./db";
import { isValidHandle, normaliseHandle, parsePairings, type Pair } from "./pairings";
import { ROLES, TAB_COLOR, TAB_LABEL, messageLabel, mortalInfoText, roleForThread, tabName, threadIdFor } from "./topics";

export interface Env {
  BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  /** Secret, not a var: comma-separated Telegram user IDs. Unset means no admins. */
  ADMIN_IDS?: string;
  EVENT_NAME?: string;
  DB: D1Database;
}

const helpText = (eventName: string) => `Use the tabs at the top to chat with your angel or mortal:
${TAB_LABEL.angel}: your secret angel, who takes care of you
${TAB_LABEL.mortal}: your mortal, who you take care of

important notes:
• messages typed outside the tabs are NOT sent, make sure to type inside the correct thread
• edits and deletes don't reach the other person! once a message is sent, it's sent

Have fun!
`;

const ADMIN_HELP = `🛠 Admin commands

  /upload: replace all pairings. Send a .csv with /upload as the caption, columns: angel, mortal, preferences (optional; save from Excel as "CSV UTF-8"). Or paste "angel,mortal" lines after the command
/pairs: list every pairing and who hasn't joined
/status: join and message counts
/missing: handles that haven't started the bot
/broadcast <message>: announce to everyone who has joined
/pause, /resume: stop/start all relaying
/swap @old @new: fix a participant's handle
/unbind @handle: detach the Telegram account that joined as @handle (if the wrong person got in)
/undoupload: restore the pairings from before the last /upload
/myid: show your Telegram ID`;

const flip = (role: Role): Role => (role === "mortal" ? "angel" : "mortal");

const article = (role: Role) => (role === "angel" ? "an angel" : "a mortal");

/** Joins up to 20 lines, noting how many were left out. */
function clip(lines: string[], max = 20): string {
  const shown = lines.slice(0, max).map((l) => `• ${l}`);
  if (lines.length > max) shown.push(`…and ${lines.length - max} more`);
  return shown.join("\n");
}

/** Splits lines into messages under Telegram's 4096-character limit. */
function chunkLines(lines: string[], limit = 4000): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const line of lines) {
    if (current && current.length + line.length + 1 > limit) {
      chunks.push(current);
      current = "";
    }
    current += (current ? "\n" : "") + line;
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * Creates whichever of `p`'s two tabs don't exist yet, renames any whose name is out of date (the
 * Mortal tab names their mortal, so it changes when the pairings do), and returns `p` with both
 * thread ids. `p` must have started the bot.
 */
async function ensureTabs(api: Api, db: Db, p: Participant): Promise<Participant> {
  const mortal = await db.partner(p.handle, "mortal");
  for (const role of ROLES) {
    const name = tabName(role, mortal?.handle ?? null);
    const threadId = threadIdFor(p, role);

    if (threadId === null) {
      const topic = await api.createForumTopic(p.chat_id!, name, { icon_color: TAB_COLOR[role] });
      if (!(await db.setThreadId(p.handle, role, topic.message_thread_id, name))) {
        // A concurrent request created this tab first: keep theirs, drop ours.
        await api.deleteForumTopic(p.chat_id!, topic.message_thread_id).catch(() => {});
      }
      p = (await db.byHandle(p.handle)) ?? p;
      continue;
    }

    const current = role === "angel" ? p.angel_tab_name : p.mortal_tab_name;
    if (current === name) continue;
    try {
      await api.editForumTopic(p.chat_id!, threadId, { name });
      await db.setTabName(p.handle, role, name);
      p = role === "angel" ? { ...p, angel_tab_name: name } : { ...p, mortal_tab_name: name };
    } catch (err) {
      // An out-of-date name is cosmetic: never let it block a message. It's retried next time.
      console.error(`renaming @${p.handle}'s ${role} tab failed:`, err);
    }
  }
  return p;
}

function shift(entities: MessageEntity[] | undefined, by: number): MessageEntity[] {
  return (entities ?? []).map((e) => ({ ...e, offset: e.offset + by }));
}

/**
 * Re-sends `msg` into thread `threadId` of `chatId` without any trace of the original sender,
 * prefixed with `label`. Returns the ids of every message created in the recipient's chat.
 */
async function deliver(
  api: Api,
  msg: Message,
  chatId: number,
  threadId: number,
  label: string,
  replyTo?: number,
): Promise<number[]> {
  const header = `${label}:\n`;
  const bold: MessageEntity = { type: "bold", offset: 0, length: label.length + 1 };
  const reply_parameters = replyTo ? { message_id: replyTo, allow_sending_without_reply: true } : undefined;

  if (msg.text !== undefined && header.length + msg.text.length <= 4096) {
    const sent = await api.sendMessage(chatId, header + msg.text, {
      message_thread_id: threadId,
      entities: [bold, ...shift(msg.entities, header.length)],
      link_preview_options: msg.link_preview_options,
      reply_parameters,
    });
    return [sent.message_id];
  }

  const captionable = !!(msg.photo || msg.video || msg.animation || msg.document || msg.audio || msg.voice);
  const caption = msg.caption ?? "";
  if (captionable && header.length + caption.length <= 1024) {
    const sent = await api.copyMessage(chatId, msg.chat.id, msg.message_id, {
      message_thread_id: threadId,
      caption: header + caption,
      caption_entities: [bold, ...shift(msg.caption_entities, header.length)],
      show_caption_above_media: msg.show_caption_above_media,
      reply_parameters,
    });
    return [sent.message_id];
  }

  // Stickers, video notes, locations, over-long text... send the label separately, in the same tab.
  const head = await api.sendMessage(chatId, label, {
    message_thread_id: threadId,
    entities: [{ type: "bold", offset: 0, length: label.length }],
    reply_parameters,
  });
  const sent = await api.copyMessage(chatId, msg.chat.id, msg.message_id, { message_thread_id: threadId });
  return [head.message_id, sent.message_id];
}

const isThreadGone = (err: unknown) =>
  err instanceof GrammyError && err.error_code === 400 && /thread not found/i.test(err.description);

/** Delivers `msg` into `dest`'s tab for talking to their `role`, recreating the tab once if it was lost. */
async function deliverToTab(
  api: Api,
  db: Db,
  msg: Message,
  dest: Participant,
  role: Role,
  label: string,
  replyTo?: number,
) {
  let p = await ensureTabs(api, db, dest);
  const threadId = threadIdFor(p, role)!;
  try {
    return await deliver(api, msg, p.chat_id!, threadId, label, replyTo);
  } catch (err) {
    if (!isThreadGone(err)) throw err;
    await db.clearThreadId(p.handle, role, threadId);
    p = await ensureTabs(api, db, (await db.byHandle(p.handle)) ?? p);
    return await deliver(api, msg, p.chat_id!, threadIdFor(p, role)!, label, replyTo);
  }
}

const ANNOUNCEMENT = "📢 Announcement from the organisers";

// Each send is one outgoing request; stay well under the free plan's 50 per invocation.
const BROADCAST_INLINE_BATCH = 25;
export const BROADCAST_CRON_BATCH = 40;

/**
 * Sends up to `limit` queued broadcast messages. Called inline by /broadcast and every minute by
 * the cron trigger. The free Workers plan allows only 50 outgoing requests per invocation, so a
 * broadcast to ~60 people has to be spread across invocations.
 */
export async function drainBroadcastQueue(api: Api, db: Db, limit: number) {
  const batch = await db.claimBroadcasts(limit);
  let sent = 0;
  let failed = 0;
  for (let i = 0; i < batch.length; i++) {
    const { chat_id, text, thread_id, announce } = batch[i];
    try {
      const thread = { message_thread_id: thread_id ?? undefined };
      if (announce) {
        await api.sendMessage(chat_id, `${ANNOUNCEMENT}\n\n${text}`, {
          ...thread,
          entities: [{ type: "bold", offset: 0, length: ANNOUNCEMENT.length }],
        });
      } else {
        await api.sendMessage(chat_id, text, thread);
      }
      sent++;
    } catch (err) {
      if (err instanceof GrammyError && err.error_code === 429) {
        // Rate limited: put this and the rest back for the next cron run.
        await db.requeueBroadcasts(batch.slice(i));
        break;
      }
      // Blocked the bot, deleted account, etc. Retrying won't help.
      console.error(`broadcast to ${chat_id} failed:`, err);
      failed++;
    }
  }
  return { sent, failed };
}

export function createBot(env: Env): Bot {
  const bot = new Bot(env.BOT_TOKEN);

  bot.use(async (ctx, next) => {
    if (ctx.from?.is_bot) return;
    await next();
  });

  const db = new Db(env.DB);
  const admins = new Set(parseAdminIds(env.ADMIN_IDS).ids);
  const isAdmin = (ctx: Context) => !!ctx.from && admins.has(ctx.from.id);
  const HELP = helpText(env.EVENT_NAME?.trim() || "Angel & Mortal");

  // Never let one bad update fail the webhook (Telegram would retry it forever),
  // but tell the user, so a lost message isn't silent.
  bot.use(async (ctx, next) => {
    try {
      await next();
    } catch (err) {
      console.error(`update ${ctx.update.update_id} failed:`, err);
      if (ctx.chat?.type === "private") {
        const failed = ctx.msg?.message_id;
        await ctx
          .reply("⚠️ Something went wrong on my side, so that didn't go through. Please try again.", {
            reply_parameters: failed ? { message_id: failed, allow_sending_without_reply: true } : undefined,
          })
          .catch(() => {});
      }
    }
  });

  const pm = bot.chatType("private");

  /** Finds the sender's participant record, binding their Telegram account on first contact. */
  async function resolve(ctx: Context): Promise<Participant | null> {
    const from = ctx.from!;
    const known = await db.byUserId(from.id);
    if (known) return known;

    const username = from.username?.toLowerCase();
    if (!username) return null;
    const p = await db.byHandle(username);
    if (!p || (p.user_id !== null && p.user_id !== from.id)) return null;

    await db.bindUser(p.handle, from.id, ctx.chat!.id);
    return { ...p, user_id: from.id, chat_id: ctx.chat!.id };
  }

  async function requireParticipant(ctx: Context): Promise<Participant | null> {
    const p = await resolve(ctx);
    if (p) return p;
    const from = ctx.from!;
    if (!from.username) {
      await ctx.reply(
        "You don't have a Telegram username yet, so I can't match you to the participant list.\n\n" +
          "Set one in Telegram Settings → Username, make sure the organiser has it, then send /start again.",
      );
    } else if (!isAdmin(ctx)) {
      await ctx.reply(
        `@${from.username} isn't on the participant list. If you think this is a mistake, contact the organiser.\n\n(Your Telegram ID: ${from.id})`,
      );
    } else {
      await ctx.reply("You're an admin but not a participant. Send /admin for admin commands.");
    }
    return null;
  }

  pm.command("start", async (ctx) => {
    let me = await requireParticipant(ctx);
    if (!me) return;
    const mortal = await db.partner(me.handle, "mortal");
    const { room_number, preferences } = await db.mortalInfo(me.handle);
    const info = mortalInfoText(room_number, preferences);
    try {
      me = await ensureTabs(ctx.api, db, me);
    } catch (err) {
      console.error(`creating tabs for @${me.handle} failed:`, err);
      await ctx.reply(
        "⚠️ I couldn't set up your Angel and Mortal tabs. Make sure your Telegram app is up to date, then send /start again. " +
          "If it keeps happening, tell the organiser.",
      );
      return;
    }

    const intro: Record<Role, string> = {
      angel: "😇 Chat with your secret angel here.",
      mortal: mortal
        ? `🙂 Chat with your mortal, @${mortal.handle}, here. They don't know it's you.` 
        : "You don't have a mortal assigned yet.",
    };
    for (const role of ROLES) {
      await ctx.api.sendMessage(ctx.chat.id, intro[role], { message_thread_id: threadIdFor(me, role)! });
    }

    await ctx.reply(
      `Welcome to A&M! 🎉` +
        (mortal ? ` Your mortal is @${mortal.handle}. Take good care of them :)` : "") +
        (mortal && info ? `\n\n${info}` : ""),
      // Clears the old mode-switching keyboard.
      { reply_markup: { remove_keyboard: true } },
    );

    await ctx.reply(HELP);
  });

  pm.command("help", (ctx) => ctx.reply(HELP));
  pm.command("myid", (ctx) => ctx.reply(`Your Telegram ID: ${ctx.from.id}`));

  pm.command("whoismymortal", async (ctx) => {
    const me = await requireParticipant(ctx);
    if (!me) return;
    const mortal = await db.partner(me.handle, "mortal");
    if (!mortal) {
      await ctx.reply("You don't have a mortal assigned.");
      return;
    }
    const { room_number, preferences } = await db.mortalInfo(me.handle);
    const info = mortalInfoText(room_number, preferences);
    await ctx.reply(`Your mortal is @${mortal.handle} 🙂` + (info ? `\n\n${info}` : ""));
  });

  // ---- admin commands (non-admins fall through to "Unknown command") ----

  const admin = pm.filter(isAdmin);

  admin.command("admin", (ctx) => ctx.reply(ADMIN_HELP));

  admin.command("upload", (ctx) => handleUpload(ctx, ctx.match));

  // grammY only matches commands in message text, so catch "/upload" as a file caption here.
  admin
    .on("message:document")
    .filter((ctx) => /^\/upload\b/.test(ctx.msg.caption ?? ""))
    .use(async (ctx) => {
      const file = await ctx.api.getFile(ctx.msg.document.file_id);
      const res = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${file.file_path}`);
      await handleUpload(ctx, await res.text());
    });

  /**
   * Replaces the pairings, then tells every angel who has already joined if their mortal's
   * preferences are new or changed (a new mortal counts as changed), in their Mortal tab.
   */
  async function savePairings(ctx: Context, pairs: Pair[]) {
    const before = await db.angelSnapshot();
    await db.replacePairings(pairs);
    const after = await db.angelSnapshot();
    const notes = [];
    for (const now of after.values()) {
      const info = mortalInfoText(now.room_number, now.preferences);
      const was = before.get(now.angel_handle);
      const changed = !was || was.mortal_handle !== now.mortal_handle || was.room_number !== now.room_number || was.preferences !== now.preferences;
      if (info && changed && now.chat_id !== null) {
        notes.push({
          chat_id: now.chat_id,
          thread_id: now.mortal_thread_id,
          text: `📝 Updated info about your mortal, @${now.mortal_handle}:\n\n${info}`,
        });
      }
    }
    await db.queueNotes(notes);
    if (notes.length) await drainBroadcastQueue(ctx.api, db, BROADCAST_INLINE_BATCH);
    return { ...(await db.stats()), notified: notes.length };
  }

  async function handleUpload(ctx: Context, text: string) {
    if (!text.trim()) {
      await ctx.reply(
        "Send a .csv file with /upload as its caption. Columns: angel handle, mortal handle, mortal's room number, mortal's preferences " +
          '(room number and preferences are optional; "nil" or "-" counts as empty). In Excel, use File → Save As → "CSV UTF-8" so emoji survive.\n\n' +
          "Or send /upload followed by one pairing per line:\n\n/upload\nangel_handle,mortal_handle\nangel_handle,mortal_handle",
      );
      return;
    }

    const { pairs, errors, warnings } = parsePairings(text);
    if (errors.length) {
      await ctx.reply(`❌ Nothing saved. Fix these and upload again:\n\n${clip(errors)}`);
      return;
    }
    const { total, joined, notified } = await savePairings(ctx, pairs);
    const withInfo = pairs.filter(([, , , preferences]) => preferences).length;
    let reply = `✅ Saved ${pairs.length} pairings (${total} participants, ${joined} already joined).`;
    reply += `\n📝 ${withInfo} of ${pairs.length} mortals have preferences.`;
    if (notified) reply += `\n📝 Telling ${notified} angels who already joined about their mortal's new info.`;
    if (warnings.length) reply += `\n\n⚠️ Warnings:\n${clip(warnings)}`;
    reply += "\n\nMistake? /undoupload restores the previous pairings.";
    await ctx.reply(reply);
  }

  admin.command("status", async (ctx) => {
    const s = await db.stats();
    await ctx.reply(
      `📊 Status\n\nParticipants: ${s.total}\nJoined the bot: ${s.joined}/${s.total}\n` +
        `Messages relayed: ${s.relayed}\nBroadcasts queued: ${s.queued}\n` +
        `Relay: ${(await db.isPaused()) ? "⏸ paused" : "▶️ running"}`,
    );
  });

  admin.command("missing", async (ctx) => {
    const handles = await db.missing();
    await ctx.reply(
      handles.length
        ? `${handles.length} haven't started the bot yet:\n\n${handles.map((h) => `@${h}`).join("\n")}`
        : "🎉 Everyone has started the bot!",
    );
  });

  admin.command("pairs", async (ctx) => {
    const rows = await db.allPairs();
    if (!rows.length) {
      await ctx.reply("No pairings uploaded yet. Use /upload.");
      return;
    }
    const mark = (joined: number) => (joined ? "" : " ⏳");
    const lines = rows.map((r) => `@${r.angel_handle}${mark(r.angel_joined)} → @${r.mortal_handle}${mark(r.mortal_joined)}`);
    for (const chunk of chunkLines(["Angel → Mortal (⏳ = not joined)", "", ...lines])) await ctx.reply(chunk);
  });

  admin.command("pause", async (ctx) => {
    await db.setPaused(true);
    await ctx.reply("⏸ Relay paused. Participants will be told to try later. /resume to restart.");
  });

  admin.command("resume", async (ctx) => {
    await db.setPaused(false);
    await ctx.reply("▶️ Relay resumed.");
  });

  admin.command("broadcast", async (ctx) => {
    const text = ctx.match.trim();
    if (!text) {
      await ctx.reply("Usage: /broadcast <message>\n\nSends the message to everyone who has started the bot.");
      return;
    }
    const queued = await db.queueBroadcast(text);
    if (queued === 0) {
      await ctx.reply("Nobody has started the bot yet, so there's no one to send to.");
      return;
    }
    // Send the first batch now; the cron trigger delivers the rest within a minute or two.
    const { sent, failed } = await drainBroadcastQueue(ctx.api, db, BROADCAST_INLINE_BATCH);
    const remaining = queued - sent - failed;
    let reply = `📢 Broadcast to ${queued} people: ${sent} sent now`;
    if (failed) reply += `, ${failed} failed (they blocked the bot)`;
    reply += remaining > 0 ? `, ${remaining} more within ~${Math.ceil(remaining / BROADCAST_CRON_BATCH)} min.` : ".";
    await ctx.reply(reply);
  });

  admin.command("swap", async (ctx) => {
    const [oldHandle, newHandle] = ctx.match.split(/\s+/).map(normaliseHandle);
    if (!oldHandle || !newHandle) {
      await ctx.reply("Usage: /swap @old_handle @new_handle");
      return;
    }
    if (!isValidHandle(newHandle)) {
      await ctx.reply(`"@${newHandle}" is not a valid Telegram username.`);
      return;
    }
    if (!(await db.byHandle(oldHandle))) {
      await ctx.reply(`@${oldHandle} isn't a participant.`);
      return;
    }
    if (!(await db.swapHandle(oldHandle, newHandle))) {
      await ctx.reply(`@${newHandle} is already a participant.`);
      return;
    }
    await ctx.reply(`✅ @${oldHandle} is now @${newHandle}. Their pairings are unchanged.`);
  });

  admin.command("unbind", async (ctx) => {
    const handle = normaliseHandle(ctx.match.trim().split(/\s+/)[0]);
    if (!handle) {
      await ctx.reply("Usage: /unbind @handle\n\nDetaches the Telegram account that joined as @handle, e.g. if the wrong person got in.");
      return;
    }
    const p = await db.byHandle(handle);
    if (!p) {
      await ctx.reply(`@${handle} isn't a participant.`);
      return;
    }
    if (p.user_id === null) {
      await ctx.reply(`@${handle} hasn't joined, so there's nothing to unbind.`);
      return;
    }
    await db.unbind(handle);
    await ctx.reply(
      `✅ Detached Telegram account ${p.user_id} from @${handle}. The next account with that username to message the bot will join as them.\n\n` +
        `If the wrong account still holds that username, it will just join again: also /swap @${handle} to the person's real username.`,
    );
  });

  admin.command("undoupload", async (ctx) => {
    const previous = await db.backupPairs();
    if (!previous.length) {
      await ctx.reply("There are no previous pairings to restore.");
      return;
    }
    // Restoring goes through replacePairings, so the current pairings become the backup: /undoupload again redoes.
    const { total, joined, notified } = await savePairings(ctx, previous);
    await ctx.reply(
      `↩️ Restored ${previous.length} previous pairings (${total} participants, ${joined} joined).` +
        (notified ? ` 📝 Telling ${notified} angels about their mortal's restored info.` : "") +
        " Send /undoupload again to switch back.",
    );
  });

  // ---- relay: must be registered last ----

  pm.on("message", async (ctx) => {
    const msg = ctx.msg;
    if (msg.text?.startsWith("/")) {
      await ctx.reply("Unknown command. Send /help to see what I can do.");
      return;
    }

    const participant = await requireParticipant(ctx);
    if (!participant) return;
    // Creates their tabs if they joined by messaging instead of /start, and keeps the names current.
    const me = await ensureTabs(ctx.api, db, participant);

    /** Tells the sender this message wasn't delivered, as a Reply to it so they can see which one. */
    const warn = (text: string) =>
      ctx.reply(text, { reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true } });

    // The tab the message was typed in decides who it's for.
    const role = roleForThread(me, msg.is_topic_message ? msg.message_thread_id : undefined);
    if (!role) {
      await warn(
        `⚠️ Not sent. Type inside the ${TAB_LABEL.angel} or ${TAB_LABEL.mortal} at the top of this chat.\n\n` +
          "Can't see the tabs? Use the Telegram phone app.",
      );
      return;
    }
    if (await db.isPaused()) {
      await warn("⏸ Not delivered: messaging is paused by the organisers right now. Please try again later.");
      return;
    }

    const dest = await db.partner(me.handle, role);
    if (!dest) {
      await warn(`⚠️ Not delivered: you don't have ${article(role)} assigned. Contact the organiser.`);
      return;
    }
    if (dest.chat_id === null) {
      await warn(`⚠️ Not delivered: your ${role} hasn't started the bot yet. Try again later.`);
      return;
    }

    // A Telegram "Reply" to a relayed message is shown as a reply on the other side too.
    let replyTo: number | undefined;
    if (msg.reply_to_message) {
      const origin = await db.getMap(ctx.chat.id, msg.reply_to_message.message_id);
      // Ignore stale mappings if the pairings were re-uploaded since.
      if (origin?.sender_role === role && origin.sender_handle === dest.handle) replyTo = origin.src_msg_id;
    }

    let sentIds: number[];
    try {
      // My Mortal tab delivers into my mortal's Angel tab, and vice versa.
      sentIds = await deliverToTab(ctx.api, db, msg, dest, flip(role), messageLabel(flip(role), me.handle), replyTo);
    } catch (err) {
      if (err instanceof GrammyError && err.error_code === 403) {
        await warn(`⚠️ Not delivered: your ${role} has blocked or stopped the bot.`);
        return;
      }
      if (err instanceof GrammyError && err.error_code === 400) {
        await warn("⚠️ Not delivered: I can't relay this kind of message.");
        return;
      }
      if (err instanceof GrammyError && err.error_code === 429) {
        const wait = err.parameters.retry_after ?? 5;
        await warn(`⚠️ Not delivered: you're sending too fast. Wait ${wait}s, then send this one again.`);
        return;
      }
      console.error(`relay of update ${ctx.update.update_id} failed:`, err);
      await warn("⚠️ Not delivered because of a temporary error. Please send it again.");
      return;
    }

    // Delivered, so no reply to the sender. From here on, never make them think it failed
    // (they'd resend a duplicate).
    try {
      await db.saveMap(dest.chat_id, sentIds, {
        sender_handle: me.handle,
        sender_role: flip(role),
        src_chat_id: ctx.chat.id,
        src_msg_id: msg.message_id,
      });
    } catch (err) {
      // Only cost: a Reply to this message won't show as a reply on the other side.
      console.error(`saveMap for update ${ctx.update.update_id} failed:`, err);
    }
  });

  return bot;
}
