#!/usr/bin/env node
/**
 * Prints the chat ids of people who recently messaged your bot, so you can
 * set TELEGRAM_CHAT_ID. Usage: send any message to the bot, then run
 *   TELEGRAM_BOT_TOKEN=... npm run telegram:whoami
 * The token is read from the environment and never printed.
 */
const { TelegramClient } = require('../pipeline/telegram');

(async () => {
  const client = new TelegramClient({ fake: false, chatId: 'unset' });
  const updates = await client.call('getUpdates', { timeout: 0, allowed_updates: ['message'] });
  const chats = new Map();
  for (const update of updates) {
    const chat = update.message?.chat;
    if (chat) chats.set(chat.id, [chat.first_name, chat.last_name, chat.username ? `@${chat.username}` : ''].filter(Boolean).join(' '));
  }
  if (!chats.size) {
    console.log('No messages found. Open your bot in Telegram, press Start, send "hi", then run this again.');
    return;
  }
  for (const [id, name] of chats) console.log(`TELEGRAM_CHAT_ID=${id}   (${name})`);
})().catch(error => {
  console.error(error.message);
  process.exit(1);
});
