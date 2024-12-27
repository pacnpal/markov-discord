export interface MarkovDataCustom {
  attachments: string[];
}

export interface TrainingState {
  guildId: string;
  lastMessageId?: string;
  lastChannelId?: string;
  processedChannels: string[];
  totalMessages: number;
  lastUpdate: string;
  inProgress: boolean;
  error?: {
    message: string;
    channelId?: string;
    messageId?: string;
    timestamp: string;
  };
}