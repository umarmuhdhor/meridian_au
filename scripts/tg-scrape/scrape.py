"""Scrape a Telegram group you are a member of into JSONL, for offline analysis.

Read-only: it never sends, edits or marks anything as read. It logs in as YOUR
user account (Telethon / MTProto) because the Bot API cannot read history.

Setup (once):
  1. https://my.telegram.org -> API development tools -> create an app.
  2. Put TG_API_ID and TG_API_HASH in scripts/tg-scrape/.env (gitignored).
  3. python -m venv scripts/tg-scrape/.venv
     scripts/tg-scrape/.venv/Scripts/pip install -r scripts/tg-scrape/requirements.txt

Usage (from the repo root, with the venv's python):
  scrape.py list                     groups/channels you are in, with their ids
  scrape.py topics <group>           forum topics of a group, with their ids
  scrape.py fetch <group> [--topic ID] [--photos]
                                     first run = full history, later = only new

The first run asks for your phone number, the login code and (if set) your 2FA
password, then keeps a session in data/tg-scrape/. That session file IS your
Telegram login: never share or commit it (/data/ is gitignored).

Output: data/tg-scrape/<chat_id>.jsonl (or <chat_id>-t<topic>.jsonl with
--topic), one message per line, oldest first. The
file is its own checkpoint, so an interrupted run resumes where it stopped.
Authors are stored as a short hash of their user id, never their name.
"""

import argparse
import asyncio
import hashlib
import json
import os
import sys
from pathlib import Path

from telethon import TelegramClient, functions, utils
from telethon.errors import FloodWaitError, RPCError

REPO_ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = REPO_ROOT / "data" / "tg-scrape"
SESSION = DATA_DIR / "telegram"  # Telethon appends .session


def load_credentials():
    """TG_API_ID / TG_API_HASH from the environment, else scripts/tg-scrape/.env.

    Not the repo-root .env: the daemon loads that one, and these keys are no
    business of the trading process.
    """
    env_file = Path(__file__).resolve().parent / ".env"
    if env_file.exists():
        # utf-8-sig: Notepad / PowerShell 5 write a BOM that would hide the first key.
        for line in env_file.read_text(encoding="utf-8-sig").splitlines():
            key, sep, value = line.partition("=")
            key = key.strip()
            if sep and key.startswith("TG_") and key not in os.environ:
                os.environ[key] = value.strip().strip("\"'")
    api_id, api_hash = os.environ.get("TG_API_ID"), os.environ.get("TG_API_HASH")
    if not api_id or not api_hash:
        sys.exit("TG_API_ID / TG_API_HASH missing in scripts/tg-scrape/.env (get them at https://my.telegram.org)")
    return int(api_id), api_hash


def author_tag(sender_id):
    if sender_id is None:
        return None
    return "u_" + hashlib.sha256(str(sender_id).encode()).hexdigest()[:8]


def topic_id(reply):
    """Forum topic a message belongs to, or None (plain group / General topic)."""
    if reply is None:
        return None
    if reply.reply_to_top_id:
        return reply.reply_to_top_id
    return reply.reply_to_msg_id if reply.forum_topic else None


def last_saved_id(path):
    """Highest message id already in the file, 0 when there is none.

    A torn last line from a crash does not parse, so that message is fetched
    again on the next run.
    """
    last = 0
    if path.exists():
        with path.open(encoding="utf-8") as f:
            for line in f:
                try:
                    last = max(last, json.loads(line)["id"])
                except (ValueError, KeyError):
                    continue
    return last


def ends_mid_line(path):
    if not path.exists() or path.stat().st_size == 0:
        return False
    with path.open("rb") as f:
        f.seek(-1, os.SEEK_END)
        return f.read(1) != b"\n"


async def resolve(client, chat):
    target = int(chat) if chat.lstrip("-").isdigit() else chat
    try:
        return await client.get_entity(target)
    except ValueError:
        # A bare numeric id resolves only once the entity is cached; listing
        # the dialogs caches every group we are in.
        await client.get_dialogs()
        return await client.get_entity(target)


async def list_chats(client):
    async for d in client.iter_dialogs():
        if d.is_group or d.is_channel:
            handle = getattr(d.entity, "username", None)
            print(f"{d.id:>16}  {'@' + handle if handle else '-':<24}  {d.name}")


async def list_topics(client, chat):
    """Forum topics of a group; their ids match the `topic` field of the JSONL.

    Posts in the General topic (id 1) carry no reply header, so their `topic`
    is null rather than 1.
    """
    entity = await resolve(client, chat)
    try:
        result = await client(functions.messages.GetForumTopicsRequest(
            peer=entity, offset_date=None, offset_id=0, offset_topic=0, limit=100))
    except RPCError as e:
        sys.exit(f"no topics ({e.__class__.__name__}): is this group a forum?")
    for t in result.topics:
        print(f"{t.id:>8}  {getattr(t, 'title', '(deleted)')}")


async def fetch(client, chat, photos, topic):
    entity = await resolve(client, chat)
    peer_id = utils.get_peer_id(entity)
    # A topic gets its own file: the checkpoint is the file's highest id, so
    # mixing a topic-only run into the whole-group file would skip the rest.
    out = DATA_DIR / (f"{peer_id}-t{topic}.jsonl" if topic else f"{peer_id}.jsonl")
    photo_dir = DATA_DIR / f"{peer_id}-photos"
    since = last_saved_id(out)
    where = f"topic {topic}" if topic else "all topics"
    print(f"{utils.get_display_name(entity)} ({peer_id}, {where}): fetching messages after id {since}")

    count = 0
    with out.open("a", encoding="utf-8") as f:
        if ends_mid_line(out):
            f.write("\n")
        async for msg in client.iter_messages(entity, min_id=since, reverse=True, reply_to=topic):
            if msg.action is not None:  # joins, pins, title changes
                continue
            if not msg.message and not msg.photo:  # stickers, voice notes, files
                continue
            photo = None
            if photos and msg.photo:
                photo_dir.mkdir(exist_ok=True)
                saved = await client.download_media(msg, file=str(photo_dir / f"{msg.id}.jpg"))
                photo = Path(saved).relative_to(DATA_DIR).as_posix() if saved else None
            record = {
                "id": msg.id,
                "date": msg.date.isoformat(),
                "author": author_tag(msg.sender_id),
                "text": msg.message or "",
                "reply_to": msg.reply_to.reply_to_msg_id if msg.reply_to else None,
                "topic": topic_id(msg.reply_to),
                "forwarded": msg.fwd_from is not None,
                "has_photo": msg.photo is not None,
                "photo": photo,
            }
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
            count += 1
            if count % 500 == 0:
                f.flush()
                print(f"  {count} messages, now at {msg.date:%Y-%m-%d}")
    print(f"done: {count} new messages -> {out}")


async def main():
    parser = argparse.ArgumentParser(description="Read-only Telegram group scraper (JSONL).")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list", help="groups/channels you are in, with their ids")
    topics_cmd = sub.add_parser("topics", help="forum topics of one group, with their ids")
    topics_cmd.add_argument("chat", help="id from `list`, @username or t.me link")
    fetch_cmd = sub.add_parser("fetch", help="download new messages of one group")
    fetch_cmd.add_argument("chat", help="id from `list`, @username or t.me link")
    fetch_cmd.add_argument("--photos", action="store_true", help="also download photos (PnL screenshots)")
    fetch_cmd.add_argument("--topic", type=int, help="only this forum topic (id from `topics`)")
    args = parser.parse_args()

    api_id, api_hash = load_credentials()
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    # Waits up to 5 min are slept through; longer ones abort (rerun resumes).
    client = TelegramClient(str(SESSION), api_id, api_hash, flood_sleep_threshold=300)
    async with client:
        try:
            if args.cmd == "list":
                await list_chats(client)
            elif args.cmd == "topics":
                await list_topics(client, args.chat)
            else:
                await fetch(client, args.chat, args.photos, args.topic)
        except FloodWaitError as e:
            sys.exit(f"Telegram rate limit: wait {e.seconds}s, then run again (it resumes).")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    asyncio.run(main())
