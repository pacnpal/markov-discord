import 'source-map-support/register';
import { CONFIG_DIR } from './config/setup';
import 'reflect-metadata';
import * as Discord from 'discord.js';

import Markov, {
  MarkovGenerateOptions,
  MarkovConstructorOptions,
  AddDataProps,
} from 'markov-strings-db';
import { DataSource } from 'typeorm';
import { MarkovInputData } from 'markov-strings-db/dist/src/entity/MarkovInputData';
import type { PackageJsonPerson } from 'types-package-json';
import makeEta from 'simple-eta';
import formatDistanceToNow from 'date-fns/formatDistanceToNow';
import addSeconds from 'date-fns/addSeconds';
import L from './logger';
import { Channel } from './entity/Channel';
import { Guild } from './entity/Guild';
import { config } from './config';
import {
  CHANNEL_OPTIONS_MAX,
  deployCommands,
  helpCommand,
  inviteCommand,
  listenChannelCommand,
  messageCommand,
  trainCommand,
  autoRespondCommand,
} from './deploy-commands';
import { getRandomElement, getVersion, packageJson } from './util';
import ormconfig from './ormconfig';

interface MarkovDataCustom {
  attachments: string[];
}

interface SelectMenuChannel {
  id: string;
  listen?: boolean;
  autoRespond?: boolean;
  name?: string;
}

interface IRefreshUrlsRes {
  refreshed_urls: Array<{
    original: string;
    refreshed: string;
  }>;
}

/**
 * Reply options that can be used in both MessageOptions and InteractionReplyOptions
 */
type AgnosticReplyOptions = Omit<Discord.MessageCreateOptions, 'reply' | 'stickers' | 'flags'>;

const INVALID_PERMISSIONS_MESSAGE = 'You do not have the permissions for this action.';
const INVALID_GUILD_MESSAGE = 'This action must be performed within a server.';

const rest = new Discord.REST({ 
version: '10',
timeout: 120000,  // 120 seconds
retries: 3
}).setToken(config.token);

const client = new Discord.Client<true>({
  failIfNotExists: false,
  intents: [
    Discord.GatewayIntentBits.GuildMessages,
    Discord.GatewayIntentBits.Guilds,
    Discord.GatewayIntentBits.GuildMembers
  ],
  presence: {
    activities: [
      {
        type: Discord.ActivityType.Playing,
        name: config.activity,
        url: packageJson().homepage,
      },
    ],
  },
});

const markovOpts: MarkovConstructorOptions = {
  stateSize: config.stateSize,
};

const markovGenerateOptions: MarkovGenerateOptions<MarkovDataCustom> = {
  filter: (result): boolean => {
    return (
      result.score >= config.minScore && !result.refs.some((ref) => ref.string === result.string)
    );
  },
  maxTries: config.maxTries,
};

async function refreshCdnUrl(url: string): Promise<string> {
  // Thank you https://github.com/ShufflePerson/Discord_CDN
  const resp = (await rest.post(`/attachments/refresh-urls`, {
    body: { attachment_urls: [url] },
  })) as IRefreshUrlsRes;
  return resp.refreshed_urls[0].refreshed;
}

async function getMarkovByGuildId(guildId: string): Promise<Markov> {
  const markov = new Markov({ id: guildId, options: { ...markovOpts, id: guildId } });
  L.trace({ guildId }, 'Setting up markov instance');
  await markov.setup(); // Connect the markov instance to the DB to assign it an ID
  return markov;
}

/**
 * Returns a thread channels parent guild channel ID, otherwise it just returns a channel ID
 */
function getGuildChannelId(channel: Discord.TextBasedChannel): string | null {
  if (channel.isThread()) {
    return channel.parentId;
  }
  return channel.id;
}

async function isValidChannel(channel: Discord.TextBasedChannel): Promise<boolean> {
  const channelId = getGuildChannelId(channel);
  if (!channelId) return false;
  const dbChannel = await Channel.findOneBy({ id: channelId });
  return dbChannel?.listen || false;
}

async function isAutoRespondChannel(channel: Discord.TextBasedChannel): Promise<boolean> {
  const channelId = getGuildChannelId(channel);
  if (!channelId) return false;
  const dbChannel = await Channel.findOneBy({ id: channelId });
  return dbChannel?.autoRespond || false;
}

async function getAutoRespondChannels(guild: Discord.Guild): Promise<Discord.TextChannel[]> {
  const dbChannels = await Channel.findBy({ guild: { id: guild.id }, autoRespond: true });
  const channels = (
    await Promise.all(
      dbChannels.map(async (dbc) => {
        try {
          return guild.channels.fetch(dbc.id);
        } catch (err) {
          L.error({ erroredChannel: dbc, channelId: dbc.id }, 'Error fetching channel');
          throw err;
        }
      }),
    )
  ).filter((c): c is Discord.TextChannel => c !== null && c instanceof Discord.TextChannel);
  return channels;
}

async function addAutoRespondChannels(channels: Discord.TextChannel[], guildId: string): Promise<void> {
  const dbChannels = channels.map((c) => {
    return Channel.create({ id: c.id, guild: Guild.create({ id: guildId }), autoRespond: true });
  });
  await Channel.save(dbChannels);
}

async function removeAutoRespondChannels(channels: Discord.TextChannel[], guildId: string): Promise<void> {
  const dbChannels = channels.map((c) => {
    return Channel.create({ id: c.id, guild: Guild.create({ id: guildId }), autoRespond: false });
  });
  await Channel.save(dbChannels);
}

async function listAutoRespondChannels(interaction: Discord.CommandInteraction): Promise<string> {
  if (!interaction.guildId || !interaction.guild) return INVALID_GUILD_MESSAGE;
  const channels = await getAutoRespondChannels(interaction.guild);
  const channelText = channels.reduce((list, channel) => {
    return `${list}\n • <#${channel.id}>`;
  }, '');
  return `The bot will automatically respond to all messages in ${channels.length} channel(s).${channelText}`;
}

function isHumanAuthoredMessage(message: Discord.Message | Discord.PartialMessage): boolean {
  return !(message.author?.bot || message.system);
}

async function getValidChannels(guild: Discord.Guild): Promise<Discord.TextChannel[]> {
  L.trace('Getting valid channels from database');
  const dbChannels = await Channel.findBy({ guild: { id: guild.id }, listen: true });
  L.trace({ dbChannels: dbChannels.map((c) => c.id) }, 'Valid channels from database');
  const channels = (
    await Promise.all(
      dbChannels.map(async (dbc) => {
        const channelId = dbc.id;
        try {
          return guild.channels.fetch(channelId);
        } catch (err) {
          L.error({ erroredChannel: dbc, channelId }, 'Error fetching channel');
          throw err;
        }
      }),
    )
  ).filter((c): c is Discord.TextChannel => c !== null && c instanceof Discord.TextChannel);
  return channels;
}

async function getTextChannels(guild: Discord.Guild): Promise<SelectMenuChannel[]> {
  L.trace('Getting text channels for select menu');
  const MAX_SELECT_OPTIONS = 25;
  const textChannels = guild.channels.cache.filter(
    (c): c is Discord.TextChannel => c !== null && c instanceof Discord.TextChannel,
  );
  const foundDbChannels = await Channel.findByIds(Array.from(textChannels.keys()));
  const foundDbChannelsWithName: SelectMenuChannel[] = foundDbChannels.map((c) => ({
    ...c,
    name: textChannels.find((t) => t.id === c.id)?.name,
  }));
  const notFoundDbChannels: SelectMenuChannel[] = textChannels
    .filter((c) => !foundDbChannels.find((d) => d.id === c.id))
    .map((c) => ({
      id: c.id,
      listen: false,
      autoRespond: false,
      name: textChannels.find((t) => t.id === c.id)?.name
    }));
  const limitedDbChannels = foundDbChannelsWithName
    .concat(notFoundDbChannels)
    .slice(0, MAX_SELECT_OPTIONS);
  return limitedDbChannels;
}

async function addValidChannels(channels: Discord.TextChannel[], guildId: string): Promise<void> {
  L.trace(`Adding ${channels.length} channels to valid list`);
  const dbChannels = channels.map((c) => {
    return Channel.create({ id: c.id, guild: Guild.create({ id: guildId }), listen: true });
  });
  await Channel.save(dbChannels);
}

async function removeValidChannels(
  channels: Discord.TextChannel[],
  guildId: string,
): Promise<void> {
  L.trace(`Removing ${channels.length} channels from valid list`);
  const dbChannels = channels.map((c) => {
    return Channel.create({ id: c.id, guild: Guild.create({ id: guildId }), listen: false });
  });
  await Channel.save(dbChannels);
}

/**
 * Checks if the author of a command has moderator-like permissions.
 * @param {GuildMember} member Sender of the message
 * @return {Boolean} True if the sender is a moderator.
 *
 */
function isModerator(
  member: Discord.GuildMember | Discord.APIInteractionGuildMember | null,
): boolean {
  const MODERATOR_PERMISSIONS: Discord.PermissionResolvable[] = [
    'Administrator',
    'ManageChannels',
    'KickMembers',
    'MoveMembers',
  ];
  if (!member) return false;
  if (member instanceof Discord.GuildMember) {
    return (
      MODERATOR_PERMISSIONS.some((p) => member.permissions.has(p)) ||
      config.ownerIds.includes(member.id)
    );
  }
  // TODO: How to parse API permissions?
  L.debug({ permissions: member.permissions });
  return true;
}

/**
 * Checks if the author of a command has a role in the `userRoleIds` config option (if present).
 * @param {GuildMember} member Sender of the message
 * @return {Boolean} True if the sender is a moderator.
 *
 */
function isAllowedUser(
  member: Discord.GuildMember | Discord.APIInteractionGuildMember | null,
): boolean {
  if (!config.userRoleIds.length) return true;
  if (!member) return false;
  if (member instanceof Discord.GuildMember) {
    return config.userRoleIds.some((p) => member.roles.cache.has(p));
  }
  // TODO: How to parse API permissions?
  L.debug({ permissions: member.permissions });
  return true;
}

type MessageCommands = 'respond' | 'train' | 'help' | 'invite' | 'debug' | null;

/**
 * Reads a new message and checks if and which command it is.
 * @param {Message} message Message to be interpreted as a command
 * @return {String} Command string
 */
function validateMessage(message: Discord.Message): MessageCommands {
  const messageText = message.content.toLowerCase();
  let command: MessageCommands = null;
  const thisPrefix = messageText.substring(0, config.messageCommandPrefix.length);
  if (thisPrefix === config.messageCommandPrefix) {
    const split = messageText.split(' ');
    if (split[0] === config.messageCommandPrefix && split.length === 1) {
      command = 'respond';
    } else if (split[1] === 'train') {
      command = 'train';
    } else if (split[1] === 'help') {
      command = 'help';
    } else if (split[1] === 'invite') {
      command = 'invite';
    } else if (split[1] === 'debug') {
      command = 'debug';
    }
  }
  return command;
}

function messageToData(message: Discord.Message): AddDataProps {
  const attachmentUrls = message.attachments.map((a) => a.url);
  let custom: MarkovDataCustom | undefined;
  if (attachmentUrls.length) custom = { attachments: attachmentUrls };
  const tags: string[] = [message.id];
  if (message.channel.isThread()) tags.push(message.channelId); // Add thread channel ID
  const channelId = getGuildChannelId(message.channel);
  if (channelId) tags.push(channelId); // Add guild channel ID
  if (message.guildId) tags.push(message.guildId); // Add guild ID
  return {
    string: message.content,
    custom,
    tags,
  };
}

/**
 * Recursively gets all messages in a text channel's history.
 */
import { TrainingStateManager } from './training-state';

async function saveGuildMessageHistory(
  interaction: Discord.Message | Discord.CommandInteraction,
  clean = true,
): Promise<string> {
  if (!isModerator(interaction.member)) return INVALID_PERMISSIONS_MESSAGE;
  if (!interaction.guildId || !interaction.guild) return INVALID_GUILD_MESSAGE;
  
  const stateManager = new TrainingStateManager(interaction.guildId, CONFIG_DIR);
  
  // Check if training is already in progress
  const currentState = stateManager.getState();
  if (currentState.inProgress) {
    return `Training is already in progress. Last update: ${currentState.lastUpdate}. Use /train with clean=true to restart.`;
  }

  const markov = await getMarkovByGuildId(interaction.guildId);
  const channels = await getValidChannels(interaction.guild);

  if (!channels.length) {
    L.warn({ guildId: interaction.guildId }, 'No channels to train from');
    return 'No channels configured to learn from. Set some with `/listen add`.';
  }

  if (clean) {
    L.debug('Deleting old data and resetting state');
    await markov.delete();
    stateManager.reset();
  } else {
    L.debug('Not deleting old data during training');
    // Filter out already processed channels when not cleaning
    const unprocessedChannels = channels.filter(
      channel => !stateManager.isChannelProcessed(channel.id)
    );
    if (unprocessedChannels.length === 0) {
      return 'All channels have been processed. Use clean=true to retrain.';
    }
    channels.splice(0, channels.length, ...unprocessedChannels);
  }

  stateManager.startTraining();

  const channelIds = channels.map((c) => c.id);
  L.debug({ channelIds }, `Training from text channels`);

  const messageContent = `Parsing past messages from ${channels.length} channel(s).`;

  const NO_COMPLETED_CHANNELS_TEXT = 'None';
  const completedChannelsField: Discord.APIEmbedField = {
    name: 'Completed Channels',
    value: NO_COMPLETED_CHANNELS_TEXT,
    inline: true,
  };
  const currentChannelField: Discord.APIEmbedField = {
    name: 'Current Channel',
    value: `<#${channels[0].id}>`,
    inline: true,
  };
  const currentChannelPercent: Discord.APIEmbedField = {
    name: 'Channel Progress',
    value: '0%',
    inline: true,
  };
  const currentChannelEta: Discord.APIEmbedField = {
    name: 'Channel Time Remaining',
    value: 'Pending...',
    inline: true,
  };
  const embedOptions: Discord.EmbedData = {
    title: 'Training Progress',
    fields: [completedChannelsField, currentChannelField, currentChannelPercent, currentChannelEta],
  };
  const embed = new Discord.EmbedBuilder(embedOptions);
  let progressMessage: Discord.Message;
  const updateMessageData = { content: messageContent, embeds: [embed] };
  if (interaction instanceof Discord.Message) {
    progressMessage = await interaction.reply(updateMessageData);
  } else {
    progressMessage = (await interaction.followUp(updateMessageData)) as Discord.Message;
  }

  const PAGE_SIZE = 50; // Reduced page size for better stability
  const UPDATE_RATE = 500; // More frequent updates
  const BATCH_SIZE = 100; // Number of messages to process before a small delay
  const BATCH_DELAY = 100; // Milliseconds to wait between batches
  const MAX_MEMORY_USAGE = 1024 * 1024 * 1024; // 1GB memory limit
  
  let lastUpdate = 0;
  let messagesCount = 0;
  let firstMessageDate: number | undefined;
  let batchCount = 0;

  // Monitor memory usage
  const getMemoryUsage = () => {
    const used = process.memoryUsage();
    return used.heapUsed;
  };

// Add delay between batches
const processingDelay = () => new Promise(resolve => setTimeout(resolve, BATCH_DELAY));

try {
    // eslint-disable-next-line no-restricted-syntax
    for (const channel of channels) {
    try {
        // Check if we should skip this channel (already processed)
        if (stateManager.isChannelProcessed(channel.id)) {
        L.debug({ channelId: channel.id }, 'Skipping already processed channel');
        continue;
        }
        let keepGoing = true;
        let oldestMessageID = stateManager.shouldResumeFromMessage(channel.id);
        L.debug({ channelId: channel.id, messagesCount }, `Training from channel`);
        const channelCreateDate = channel.createdTimestamp;
        const channelEta = makeEta({ autostart: true, min: 0, max: 1, historyTimeConstant: 30 });

        while (keepGoing) {
      let allBatchMessages = new Discord.Collection<string, Discord.Message<boolean>>();
      let channelBatchMessages: Discord.Collection<string, Discord.Message<boolean>>;
      try {
        // eslint-disable-next-line no-await-in-loop
        channelBatchMessages = await channel.messages.fetch({
          before: oldestMessageID,
          limit: PAGE_SIZE,
        });
      } catch (err) {
        L.error(err);
        L.error(
          `Error retreiving messages before ${oldestMessageID} in channel ${channel.name}. This is probably a permissions issue.`,
        );
        break; // Give up on this channel
      }

      // Gather any thread messages if present in this message batch
      const threadChannels = channelBatchMessages
        .filter((m) => m.hasThread)
        .map((m) => m.thread)
        .filter((c): c is Discord.AnyThreadChannel => c !== null);
      if (threadChannels.length > 0) {
        L.debug(`Found ${threadChannels.length} threads. Reading into them.`);
        // eslint-disable-next-line no-restricted-syntax
        for (const threadChannel of threadChannels) {
          let oldestThreadMessageID: string | undefined;
          let keepGoingThread = true;
          L.debug({ channelId: threadChannel.id }, `Training from thread`);

          while (keepGoingThread) {
            let threadBatchMessages: Discord.Collection<string, Discord.Message<boolean>>;
            try {
              // eslint-disable-next-line no-await-in-loop
              threadBatchMessages = await threadChannel.messages.fetch({
                before: oldestThreadMessageID,
                limit: PAGE_SIZE,
              });
            } catch (err) {
              L.error(err);
              L.error(
                `Error retreiving thread messages before ${oldestThreadMessageID} in thread ${threadChannel.name}. This is probably a permissions issue.`,
              );
              break; // Give up on this thread
            }
            L.trace(
              { threadMessagesCount: threadBatchMessages.size },
              `Found some thread messages`,
            );
            const lastThreadMessage = threadBatchMessages.last();
            allBatchMessages = allBatchMessages.concat(threadBatchMessages); // Add the thread messages to this message batch to be included in later processing
            if (!lastThreadMessage?.id || threadBatchMessages.size < PAGE_SIZE) {
              keepGoingThread = false;
            } else {
              oldestThreadMessageID = lastThreadMessage.id;
            }
          }
        }
      }

      allBatchMessages = allBatchMessages.concat(channelBatchMessages);

      try {
        // Check memory usage before processing
        const memoryUsage = getMemoryUsage();
        if (memoryUsage > MAX_MEMORY_USAGE) {
          L.warn('Memory usage too high, waiting for garbage collection');
          await processingDelay();
          global.gc?.(); // Optional garbage collection if --expose-gc flag is used
        }

        // Filter and data map messages to be ready for addition to the corpus
        const humanAuthoredMessages = allBatchMessages
          .filter((m) => isHumanAuthoredMessage(m))
          .map(messageToData);

        // Process messages in smaller batches for stability
        for (let i = 0; i < humanAuthoredMessages.length; i += BATCH_SIZE) {
          const batch = humanAuthoredMessages.slice(i, i + BATCH_SIZE);
          L.trace({ oldestMessageID, batchSize: batch.length }, `Saving batch of messages`);
          
          try {
            // eslint-disable-next-line no-await-in-loop
            await markov.addData(batch);
            batchCount++;
            messagesCount += batch.length;

            // Update state after successful batch
            const lastMessage = allBatchMessages.last();
            if (lastMessage) {
              stateManager.updateProgress(channel.id, lastMessage.id, messagesCount);
            }

            // Add delay between batches
            if (batchCount % 5 === 0) { // Every 5 batches
              await processingDelay();
            }
          } catch (err) {
            stateManager.recordError(err as Error, channel.id, oldestMessageID);
            L.error({ err, batchSize: batch.length }, 'Error saving batch of messages');
            // Continue with next batch instead of failing completely
            continue;
          }
        }
        
        L.trace('Finished processing message batches');
      } catch (err) {
        L.error({ err }, 'Error processing messages');
        // Wait a bit before continuing to next batch of messages
        await processingDelay();
      }
      const lastMessage = channelBatchMessages.last();

      // Update tracking metrics
      if (!lastMessage?.id || channelBatchMessages.size < PAGE_SIZE) {
        keepGoing = false;
        const channelIdListItem = ` • <#${channel.id}>`;
        if (completedChannelsField.value === NO_COMPLETED_CHANNELS_TEXT)
          completedChannelsField.value = channelIdListItem;
        else {
          completedChannelsField.value += `\n${channelIdListItem}`;
        }
      } else {
        oldestMessageID = lastMessage.id;
      }
      currentChannelField.value = `<#${channel.id}>`;
      if (!firstMessageDate) firstMessageDate = channelBatchMessages.first()?.createdTimestamp;
      const oldestMessageDate = lastMessage?.createdTimestamp;
      if (firstMessageDate && oldestMessageDate) {
        const channelAge = firstMessageDate - channelCreateDate;
        const lastMessageAge = firstMessageDate - oldestMessageDate;
        const pctComplete = lastMessageAge / channelAge;
        currentChannelPercent.value = `${(pctComplete * 100).toFixed(2)}%`;
        channelEta.report(pctComplete);
        const estimateSeconds = channelEta.estimate();
        if (Number.isFinite(estimateSeconds))
          currentChannelEta.value = formatDistanceToNow(addSeconds(new Date(), estimateSeconds), {
            includeSeconds: true,
          });
      }

      if (messagesCount > lastUpdate + UPDATE_RATE) {
        lastUpdate = messagesCount;
        L.debug(
          { messagesCount, pctComplete: currentChannelPercent.value },
          'Sending metrics update',
        );
        // eslint-disable-next-line no-await-in-loop
        await progressMessage.edit({
          ...updateMessageData,
          embeds: [new Discord.EmbedBuilder(embedOptions)],
        });
    }
    }
} catch (err) {
L.error({ err }, 'Error processing channel');
stateManager.recordError(err as Error);
// Continue with next channel
}
}

L.info({ channelIds }, `Trained from ${messagesCount} past human authored messages.`);
stateManager.finishTraining();
return `Trained from ${messagesCount} past human authored messages.`;
} catch (err) {
const error = err as Error;
L.error({ err }, 'Error during training completion');
stateManager.recordError(error);
return `Training encountered an error: ${error.message}. Use clean=false to resume from last checkpoint.`;
}
}

interface JSONImport {
  message: string;
  attachments?: string[];
}

/**
 * Train from an attached JSON file
 */
async function trainFromAttachmentJson(
  attachmentUrl: string,
  interaction: Discord.CommandInteraction,
  clean = true,
): Promise<string> {
  if (!isModerator(interaction.member)) return INVALID_PERMISSIONS_MESSAGE;
  if (!interaction.guildId || !interaction.guild) return INVALID_GUILD_MESSAGE;
  const { guildId } = interaction;
  
  const stateManager = new TrainingStateManager(guildId, CONFIG_DIR);
  
  // Check if training is already in progress
  const currentState = stateManager.getState();
  if (currentState.inProgress) {
    return `Training is already in progress. Last update: ${currentState.lastUpdate}. Use clean=true to restart.`;
  }

  const markov = await getMarkovByGuildId(guildId);
  stateManager.startTraining();

  let trainingData: AddDataProps[];
  try {
    const getResp = await fetch(attachmentUrl);
    if (!getResp.ok) throw new Error(getResp.statusText);
    const importData = (await getResp.json()) as JSONImport[];

    trainingData = importData.map((datum, index) => {
      if (!datum.message) {
        throw new Error(`Entry at index ${index} must have a "message"`);
      }
      if (typeof datum.message !== 'string') {
        throw new Error(`Entry at index ${index} must have a "message" with a type of string`);
      }
      if (datum.attachments?.every((a) => typeof a !== 'string')) {
        throw new Error(
          `Entry at index ${index} must have all "attachments" each with a type of string`,
        );
      }
      let custom: MarkovDataCustom | undefined;
      if (datum.attachments?.length) custom = { attachments: datum.attachments };
      return {
        string: datum.message,
        custom,
        tags: [guildId],
      };
    });
  } catch (err) {
    L.error(err);
    return 'The provided attachment file has invalid formatting. See the logs for details.';
  }

  if (clean) {
    L.debug('Deleting old data');
    await markov.delete();
    stateManager.reset();
  } else {
    L.debug('Not deleting old data during training');
  }

  const BATCH_SIZE = 100;
  const BATCH_DELAY = 100;
  let processedCount = 0;
  let batchCount = 0;

  try {
    // Process messages in batches
    for (let i = 0; i < trainingData.length; i += BATCH_SIZE) {
      const batch = trainingData.slice(i, i + BATCH_SIZE);
      try {
        await markov.addData(batch);
        processedCount += batch.length;
        batchCount++;

        // Update state after successful batch
        stateManager.updateProgress('json-import', i.toString(), processedCount);

        // Add delay between batches
        if (batchCount % 5 === 0) {
          await new Promise(resolve => setTimeout(resolve, BATCH_DELAY));
        }
      } catch (err) {
        L.error({ err, batchIndex: i }, 'Error processing JSON batch');
        stateManager.recordError(err as Error, 'json-import', i.toString());
        // Continue with next batch instead of failing completely
        continue;
      }
    }

    L.info(`Successfully trained from ${processedCount} messages from JSON.`);
    stateManager.finishTraining();
    return `Successfully trained from ${processedCount} messages from JSON.`;
  } catch (err) {
    const error = err as Error;
    L.error({ err }, 'Error during JSON training completion');
    stateManager.recordError(error);
    return `Training encountered an error: ${error.message}. Use clean=false to resume from last checkpoint.`;
  }
}

interface GenerateResponse {
  message?: AgnosticReplyOptions;
  debug?: AgnosticReplyOptions;
  error?: AgnosticReplyOptions;
}

interface GenerateOptions {
  debug?: boolean;
  startSeed?: string;
}

/**
 * General Markov-chain response function
 * @param interaction The message that invoked the action, used for channel info.
 * @param debug Sends debug info as a message if true.
 * @param tts If the message should be sent as TTS. Defaults to the TTS setting of the
 * invoking message.
 */
async function generateResponse(
  interaction: Discord.Message | Discord.CommandInteraction,
  options?: GenerateOptions,
): Promise<GenerateResponse> {
  L.debug({ options }, 'Responding...');
  const { debug = false, startSeed } = options || {};
  if (!interaction.guildId) {
    L.warn('Received an interaction without a guildId');
    return { error: { content: INVALID_GUILD_MESSAGE } };
  }
  if (!isAllowedUser(interaction.member)) {
    L.info('Member does not have permissions to generate a response');
    return { error: { content: INVALID_PERMISSIONS_MESSAGE } };
  }
  const markov = await getMarkovByGuildId(interaction.guildId);

  try {
    markovGenerateOptions.startSeed = startSeed;
    const response = await markov.generate<MarkovDataCustom>(markovGenerateOptions);
    L.info({ string: response.string }, 'Generated response text');
    L.debug({ response }, 'Generated response object');
    const messageOpts: AgnosticReplyOptions = {
      allowedMentions: { repliedUser: false, parse: [] },
    };
    const attachmentUrls = response.refs
      .filter((ref) => ref.custom && 'attachments' in ref.custom)
      .flatMap((ref) => (ref.custom as MarkovDataCustom).attachments);
    if (attachmentUrls.length > 0) {
      const randomRefAttachment = getRandomElement(attachmentUrls);
      const refreshedUrl = await refreshCdnUrl(randomRefAttachment);
      messageOpts.files = [refreshedUrl];
    } else {
      const randomMessage = await MarkovInputData.createQueryBuilder<
        MarkovInputData<MarkovDataCustom>
      >('input')
        .leftJoinAndSelect('input.markov', 'markov')
        .where({ markov: markov.db })
        .orderBy('RANDOM()')
        .limit(1)
        .getOne();
      const randomMessageAttachmentUrls = randomMessage?.custom?.attachments;
      if (randomMessageAttachmentUrls?.length) {
        const attachmentUrl = getRandomElement(randomMessageAttachmentUrls);
        const refreshedUrl = await refreshCdnUrl(attachmentUrl);
        messageOpts.files = [{ attachment: refreshedUrl }];
      }
    }
    messageOpts.content = response.string;

    const responseMessages: GenerateResponse = {
      message: messageOpts,
    };
    if (debug) {
      responseMessages.debug = {
        content: `\`\`\`\n${JSON.stringify(response, null, 2)}\n\`\`\``,
        allowedMentions: { repliedUser: false, parse: [] },
      };
    }
    return responseMessages;
  } catch (err) {
    L.error(err);
    return {
      error: {
        content: `\n\`\`\`\nERROR: ${err}\n\`\`\``,
        allowedMentions: { repliedUser: false, parse: [] },
      },
    };
  }
}

async function listValidChannels(interaction: Discord.CommandInteraction): Promise<string> {
  if (!interaction.guildId || !interaction.guild) return INVALID_GUILD_MESSAGE;
  const channels = await getValidChannels(interaction.guild);
  const channelText = channels.reduce((list, channel) => {
    return `${list}\n • <#${channel.id}>`;
  }, '');
  return `This bot is currently listening and learning from ${channels.length} channel(s).${channelText}`;
}

function getChannelsFromInteraction(
  interaction: Discord.ChatInputCommandInteraction,
): Discord.TextChannel[] {
  const channels = Array.from(Array(CHANNEL_OPTIONS_MAX).keys()).map((index) =>
    interaction.options.getChannel(`channel-${index + 1}`, index === 0),
  );
  const textChannels = channels.filter(
    (c): c is Discord.TextChannel => c !== null && c instanceof Discord.TextChannel,
  );
  return textChannels;
}

function helpMessage(): AgnosticReplyOptions {
  const avatarURL = client.user.avatarURL() || undefined;
  const embed = new Discord.EmbedBuilder()
    .setAuthor({
      name: client.user.username || packageJson().name,
      iconURL: avatarURL,
    })
    .setThumbnail(avatarURL as string)
    .setDescription(
      `A Markov chain chatbot that speaks based on learned messages from previous chat input.`,
    )
    .addFields([
      {
        name: `${config.messageCommandPrefix} or /${messageCommand.name}`,
        value: `Generates a sentence based on the chat database.`,
      },

      {
        name: `/${listenChannelCommand.name}`,
        value: `Add, remove, list, or modify the list of channels the bot listens to and learns from.`,
      },

      {
        name: `/autorespond`,
        value: `Add, remove, list, or modify the list of channels where the bot will automatically respond to all messages.`,
      },

      {
        name: `${config.messageCommandPrefix} train or /${trainCommand.name}`,
        value: `Fetches the maximum amount of previous messages in the listened to text channels. This takes some time.`,
      },

      {
        name: `${config.messageCommandPrefix} invite or /${inviteCommand.name}`,
        value: `Post this bot's invite URL.`,
      },

      {
        name: `${config.messageCommandPrefix} debug or /${messageCommand.name} debug: True`,
        value: `Runs the ${config.messageCommandPrefix} command and follows it up with debug info.`,
      },
    ])
    .setFooter({
      text: `${packageJson().name} ${getVersion()} by ${
        (packageJson().author as PackageJsonPerson).name
      }`,
    });
  return {
    embeds: [embed],
  };
}

function generateInviteUrl(): string {
  return client.generateInvite({
    scopes: [Discord.OAuth2Scopes.Bot, Discord.OAuth2Scopes.ApplicationsCommands],
    permissions: [
    'ViewChannel',
    'SendMessages',
    'AttachFiles',
    'ReadMessageHistory'
  ],
  });
}

function inviteMessage(): AgnosticReplyOptions {
  const avatarURL = client.user.avatarURL() || undefined;
  const inviteUrl = generateInviteUrl();
  const embed = new Discord.EmbedBuilder()
    .setAuthor({ name: `Invite ${client.user?.username}`, iconURL: avatarURL })
    .setThumbnail(avatarURL as string)
    .addFields([
      { name: 'Invite', value: `[Invite ${client.user.username} to your server](${inviteUrl})` },
    ]);
  return { embeds: [embed] };
}

async function handleResponseMessage(
  generatedResponse: GenerateResponse,
  message: Discord.Message,
): Promise<void> {
  if (generatedResponse.message) await message.reply(generatedResponse.message);
  if (generatedResponse.debug) await message.reply(generatedResponse.debug);
  if (generatedResponse.error) await message.reply(generatedResponse.error);
}

async function handleUnprivileged(
  interaction: Discord.CommandInteraction | Discord.SelectMenuInteraction,
  deleteReply = true,
): Promise<void> {
  if (deleteReply) await interaction.deleteReply();
  await interaction.followUp({ content: INVALID_PERMISSIONS_MESSAGE, ephemeral: true });
}

async function handleNoGuild(
  interaction: Discord.CommandInteraction | Discord.SelectMenuInteraction,
  deleteReply = true,
): Promise<void> {
  if (deleteReply) await interaction.deleteReply();
  await interaction.followUp({ content: INVALID_GUILD_MESSAGE, ephemeral: true });
}

client.on('ready', async (readyClient) => {
  L.info({ inviteUrl: generateInviteUrl() }, 'Bot logged in');

  await deployCommands(readyClient.user.id);

  const guildsToSave = readyClient.guilds.valueOf().map((guild) => Guild.create({ id: guild.id }));

  // Remove the duplicate commands
  if (!config.devGuildId) {
    await Promise.all(readyClient.guilds.valueOf().map(async (guild) => guild.commands.set([])));
  }
  await Guild.upsert(guildsToSave, ['id']);
});

client.on('guildCreate', async (guild) => {
  L.info({ guildId: guild.id }, 'Adding new guild');
  await Guild.upsert(Guild.create({ id: guild.id }), ['id']);
});

client.on('debug', (m) => L.trace(m));
client.on('warn', (m) => L.warn(m));
client.on('error', (m) => L.error(m));

client.on('messageCreate', async (message) => {
  if (
    !(
      message.guild &&
      (message.channel instanceof Discord.TextChannel ||
        message.channel instanceof Discord.ThreadChannel)
    )
  )
    return;
  const command = validateMessage(message);
  if (command !== null) L.info({ command }, 'Recieved message command');
  if (command === 'help') {
    await message.channel.send(helpMessage());
  }
  if (command === 'invite') {
    await message.channel.send(inviteMessage());
  }
  if (command === 'train') {
    const response = await saveGuildMessageHistory(message);
    await message.reply(response);
  }
  if (command === 'respond') {
    L.debug('Responding to legacy command');
    const generatedResponse = await generateResponse(message);
    await handleResponseMessage(generatedResponse, message);
  }
  if (command === 'debug') {
    L.debug('Responding to legacy command debug');
    const generatedResponse = await generateResponse(message, { debug: true });
    await handleResponseMessage(generatedResponse, message);
  }
  if (command === null) {
    if (isHumanAuthoredMessage(message)) {
      if (client.user && message.mentions.has(client.user)) {
        // Check if response channels are configured and if this channel is allowed
        if (config.responseChannelIds.length > 0 && !config.responseChannelIds.includes(message.channel.id)) {
          L.debug('Ignoring mention in non-response channel');
          return;
        }
        
        L.debug('Responding to mention');
        // <@!278354154563567636> how are you doing?
        const startSeed = message.content.replace(/<@!\d+>/g, '').trim();
        const generatedResponse = await generateResponse(message, { startSeed });
        await handleResponseMessage(generatedResponse, message);
      } else if (await isAutoRespondChannel(message.channel)) {
        // Auto-respond to all messages in configured channels using message content as context
        L.debug('Auto-responding in configured channel with context');
        const startSeed = message.content.trim();
        const generatedResponse = await generateResponse(message, { startSeed });
        await handleResponseMessage(generatedResponse, message);
      }

      if (await isValidChannel(message.channel)) {
        L.debug('Listening');
        const markov = await getMarkovByGuildId(message.channel.guildId);
        await markov.addData([messageToData(message)]);
      }
    }
  }
});

client.on('messageDelete', async (message) => {
  if (!isHumanAuthoredMessage(message)) return;
  if (!(await isValidChannel(message.channel))) return;
  if (!message.guildId) return;

  L.debug(`Deleting message ${message.id}`);
  const markov = await getMarkovByGuildId(message.guildId);
  await markov.removeTags([message.id]);
});

client.on('messageUpdate', async (oldMessage, newMessage) => {
  if (!isHumanAuthoredMessage(oldMessage)) return;
  if (!(await isValidChannel(oldMessage.channel))) return;
  if (!(oldMessage.guildId && newMessage.content)) return;

  L.debug(`Editing message ${oldMessage.id}`);
  const markov = await getMarkovByGuildId(oldMessage.guildId);
  await markov.removeTags([oldMessage.id]);
  await markov.addData([newMessage.content]);
});

client.on('threadDelete', async (thread) => {
  if (!(await isValidChannel(thread))) return;
  if (!thread.guildId) return;

  L.debug(`Deleting thread messages ${thread.id}`);
  const markov = await getMarkovByGuildId(thread.guildId);
  await markov.removeTags([thread.id]);
});


client.on('interactionCreate', async (interaction) => {
  if (interaction.isChatInputCommand()) {
    L.info({ command: interaction.commandName }, 'Recieved slash command');

    if (interaction.commandName === helpCommand.name) {
      await interaction.reply(helpMessage());
    } else if (interaction.commandName === inviteCommand.name) {
      await interaction.reply(inviteMessage());
    } else if (interaction.commandName === messageCommand.name) {
      await interaction.deferReply();
      const debug = interaction.options.getBoolean('debug') || false;
      const startSeed = interaction.options.getString('seed')?.trim() || undefined;
      const generatedResponse = await generateResponse(interaction, { debug, startSeed });

      if (generatedResponse.message) {
        await interaction.editReply(generatedResponse.message);
      } else {
        await interaction.deleteReply();
      }
      if (generatedResponse.debug) await interaction.followUp(generatedResponse.debug);
      if (generatedResponse.error) {
        await interaction.followUp({ ...generatedResponse.error, ephemeral: true });
      }
    } else if (interaction.commandName === listenChannelCommand.name) {
      await interaction.deferReply();
      const subCommand = interaction.options.getSubcommand(true) as 'add' | 'remove' | 'list';
      if (subCommand === 'list') {
        const reply = await listValidChannels(interaction);
        await interaction.editReply(reply);
      } else if (subCommand === 'add') {
        if (!isModerator(interaction.member)) {
          return handleUnprivileged(interaction);
        }
        if (!interaction.guildId) {
          return handleNoGuild(interaction);
        }
        const channels = getChannelsFromInteraction(interaction);
        await addValidChannels(channels, interaction.guildId);
        await interaction.editReply(
          `Added ${channels.length} text channels to the list. Use \`/train\` to update the past known messages.`,
        );
      } else if (subCommand === 'remove') {
        if (!isModerator(interaction.member)) {
          return handleUnprivileged(interaction);
        }
        if (!interaction.guildId) {
          return handleNoGuild(interaction);
        }
        const channels = getChannelsFromInteraction(interaction);
        await removeValidChannels(channels, interaction.guildId);
        await interaction.editReply(
          `Removed ${channels.length} text channels from the list. Use \`/train\` to remove these channels from the past known messages.`,
        );
      } else if (subCommand === 'modify') {
        if (!interaction.guild) {
          return handleNoGuild(interaction);
        }
        if (!isModerator(interaction.member)) {
          await handleUnprivileged(interaction);
        }
        await interaction.deleteReply();
        const dbTextChannels = await getTextChannels(interaction.guild);
        const row = new Discord.ActionRowBuilder<Discord.StringSelectMenuBuilder>().addComponents(
          new Discord.StringSelectMenuBuilder()
            .setCustomId('listen-modify-select')
            .setPlaceholder('Nothing selected')
            .setMinValues(0)
            .setMaxValues(dbTextChannels.length)
            .addOptions(
              dbTextChannels.map((c) => ({
                label: `#${c.name}` || c.id,
                value: c.id,
                default: c.listen || false,
              })),
            ),
        );

        await interaction.followUp({
          content: 'Select which channels you would like to the bot to actively listen to',
          components: [row],
          ephemeral: true,
        });
      }
    } else if (interaction.commandName === autoRespondCommand.name) {
      await interaction.deferReply();
      const subCommand = interaction.options.getSubcommand(true) as 'add' | 'remove' | 'list' | 'modify';
      
      if (subCommand === 'list') {
        const reply = await listAutoRespondChannels(interaction);
        await interaction.editReply(reply);
      } else if (subCommand === 'add') {
        if (!isModerator(interaction.member)) {
          return handleUnprivileged(interaction);
        }
        if (!interaction.guildId) {
          return handleNoGuild(interaction);
        }
        const channels = getChannelsFromInteraction(interaction);
        await addAutoRespondChannels(channels, interaction.guildId);
        await interaction.editReply(
          `Added ${channels.length} text channels to auto-respond list.`
        );
      } else if (subCommand === 'remove') {
        if (!isModerator(interaction.member)) {
          return handleUnprivileged(interaction);
        }
        if (!interaction.guildId) {
          return handleNoGuild(interaction);
        }
        const channels = getChannelsFromInteraction(interaction);
        await removeAutoRespondChannels(channels, interaction.guildId);
        await interaction.editReply(
          `Removed ${channels.length} text channels from auto-respond list.`
        );
      } else if (subCommand === 'modify') {
        if (!interaction.guild) {
          return handleNoGuild(interaction);
        }
        if (!isModerator(interaction.member)) {
          await handleUnprivileged(interaction);
        }
        await interaction.deleteReply();
        const dbTextChannels = await getTextChannels(interaction.guild);
        const row = new Discord.ActionRowBuilder<Discord.StringSelectMenuBuilder>().addComponents(
          new Discord.StringSelectMenuBuilder()
            .setCustomId('autorespond-modify-select')
            .setPlaceholder('Nothing selected')
            .setMinValues(0)
            .setMaxValues(dbTextChannels.length)
            .addOptions(
              dbTextChannels.map((c) => ({
                label: `#${c.name}` || c.id,
                value: c.id,
                default: c.autoRespond || false,
              })),
            ),
        );

        await interaction.followUp({
          content: 'Select which channels you would like the bot to auto-respond in',
          components: [row],
          ephemeral: true,
        });
      }
    } else if (interaction.commandName === trainCommand.name) {
      await interaction.deferReply();
      const clean = interaction.options.getBoolean('clean') ?? true;
      const trainingJSON = interaction.options.getAttachment('json');

      if (trainingJSON) {
        const responseMessage = await trainFromAttachmentJson(trainingJSON.url, interaction, clean);
        await interaction.followUp(responseMessage);
      } else {
        const reply = (await interaction.fetchReply()) as Discord.Message; // Must fetch the reply ASAP
        const responseMessage = await saveGuildMessageHistory(interaction, clean);
        // Send a message in reply to the reply to avoid the 15 minute webhook token timeout
        await reply.reply({ content: responseMessage });
      }
    }
  } else if (interaction.isStringSelectMenu()) {
    if (interaction.customId === 'listen-modify-select') {
      await interaction.deferUpdate();
      const { guild } = interaction;
      if (!isModerator(interaction.member)) {
        return handleUnprivileged(interaction, false);
      }
      if (!guild) {
        return handleNoGuild(interaction, false);
      }

      const allChannels =
        (interaction.component as Discord.StringSelectMenuComponent).options?.map((o) => o.value) ||
        [];
      const selectedChannelIds = interaction.values;

      const textChannels = (
        await Promise.all(
          allChannels.map(async (c) => {
            return guild.channels.fetch(c);
          }),
        )
      ).filter((c): c is Discord.TextChannel => c !== null && c instanceof Discord.TextChannel);
      const unselectedChannels = textChannels.filter((t) => !selectedChannelIds.includes(t.id));
      const selectedChannels = textChannels.filter((t) => selectedChannelIds.includes(t.id));
      await addValidChannels(selectedChannels, guild.id);
      await removeValidChannels(unselectedChannels, guild.id);

      await interaction.followUp({
        content: 'Updated actively listened to channels list.',
        ephemeral: true,
      });
    } else if (interaction.customId === 'autorespond-modify-select') {
      await interaction.deferUpdate();
      const { guild } = interaction;
      if (!isModerator(interaction.member)) {
        return handleUnprivileged(interaction, false);
      }
      if (!guild) {
        return handleNoGuild(interaction, false);
      }

      const allChannels =
        (interaction.component as Discord.StringSelectMenuComponent).options?.map((o) => o.value) ||
        [];
      const selectedChannelIds = interaction.values;

      const textChannels = (
        await Promise.all(
          allChannels.map(async (c) => {
            return guild.channels.fetch(c);
          }),
        )
      ).filter((c): c is Discord.TextChannel => c !== null && c instanceof Discord.TextChannel);
      const unselectedChannels = textChannels.filter((t) => !selectedChannelIds.includes(t.id));
      const selectedChannels = textChannels.filter((t) => selectedChannelIds.includes(t.id));
      await addAutoRespondChannels(selectedChannels, guild.id);
      await removeAutoRespondChannels(unselectedChannels, guild.id);

      await interaction.followUp({
        content: 'Updated auto-respond channels list.',
        ephemeral: true,
      });
    }
  }
});

/**
 * Loads the config settings from disk
 */
async function main(): Promise<void> {
  const dataSourceOptions = Markov.extendDataSourceOptions(ormconfig);
  const dataSource = new DataSource(dataSourceOptions);
  await dataSource.initialize();
  await client.login(config.token);
}

main();
