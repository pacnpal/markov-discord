import fs from 'fs-extra';
import path from 'path';
import { TrainingState } from './types';
import L from './logger';

export class TrainingStateManager {
  private stateFile: string;
  private state: TrainingState;

  constructor(guildId: string, configDir: string = 'config') {
    this.stateFile = path.join(configDir, 'training-state', `${guildId}.json`);
    
    // Initialize with default state
    this.state = {
      guildId,
      processedChannels: [],
      totalMessages: 0,
      lastUpdate: new Date().toISOString(),
      inProgress: false
    };

    // Ensure directory exists
    fs.ensureDirSync(path.dirname(this.stateFile));
    
    // Load existing state if available
    this.loadState();
  }

  private loadState(): void {
    try {
      if (fs.existsSync(this.stateFile)) {
        const savedState = fs.readJsonSync(this.stateFile);
        this.state = { ...this.state, ...savedState };
        L.info({ guildId: this.state.guildId }, 'Loaded existing training state');
      }
    } catch (err) {
      L.error({ err }, 'Error loading training state');
      // Keep using default state if load fails
    }
  }

  private saveState(): void {
    try {
      fs.writeJsonSync(this.stateFile, this.state, { spaces: 2 });
    } catch (err) {
      L.error({ err }, 'Error saving training state');
    }
  }

  public startTraining(): void {
    this.state.inProgress = true;
    this.state.error = undefined;
    this.state.lastUpdate = new Date().toISOString();
    this.saveState();
  }

  public finishTraining(): void {
    this.state.inProgress = false;
    this.state.lastUpdate = new Date().toISOString();
    this.saveState();
  }

  public updateProgress(channelId: string, messageId: string, messagesProcessed: number): void {
    this.state.lastChannelId = channelId;
    this.state.lastMessageId = messageId;
    this.state.totalMessages = messagesProcessed;
    this.state.lastUpdate = new Date().toISOString();
    this.saveState();
  }

  public markChannelComplete(channelId: string): void {
    if (!this.state.processedChannels.includes(channelId)) {
      this.state.processedChannels.push(channelId);
      this.saveState();
    }
  }

  public recordError(error: Error, channelId?: string, messageId?: string): void {
    this.state.error = {
      message: error.message,
      channelId,
      messageId,
      timestamp: new Date().toISOString()
    };
    this.saveState();
  }

  public isChannelProcessed(channelId: string): boolean {
    return this.state.processedChannels.includes(channelId);
  }

  public shouldResumeFromMessage(channelId: string): string | undefined {
    if (this.state.inProgress && this.state.lastChannelId === channelId) {
      return this.state.lastMessageId;
    }
    return undefined;
  }

  public getState(): TrainingState {
    return { ...this.state };
  }

  public reset(): void {
    this.state = {
      guildId: this.state.guildId,
      processedChannels: [],
      totalMessages: 0,
      lastUpdate: new Date().toISOString(),
      inProgress: false
    };
    this.saveState();
  }
}