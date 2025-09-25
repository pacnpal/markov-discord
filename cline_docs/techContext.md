# Technical Context
Last Updated: 2024-12-27

## Core Technologies

### Current Stack
- Node.js/TypeScript
- Discord.js for Discord API
- TypeORM for database management
- SQLite for data storage
- markov-strings-db for response generation

### LLM Integration Stack
- OpenAI API for primary LLM capabilities
- sentence-transformers for embeddings
- Vector extensions for SQLite
- Redis (optional) for context caching

## Integration Patterns

### Database Schema Extensions
```sql
-- New tables for LLM integration

-- Store message embeddings
CREATE TABLE message_embeddings (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  embedding BLOB NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (message_id) REFERENCES messages(id)
);

-- Store conversation contexts
CREATE TABLE conversation_contexts (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  context_window TEXT NOT NULL,
  last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (channel_id) REFERENCES channels(id)
);
```

### API Integration
```typescript
interface LLMConfig {
  provider: 'openai' | 'local';
  model: string;
  apiKey?: string;
  maxTokens: number;
  temperature: number;
  contextWindow: number;
}

interface ResponseGenerator {
  generateResponse(options: {
    prompt: string;
    context: Message[];
    guildId: string;
    channelId: string;
  }): Promise<string>;
}
```

### Message Processing Pipeline
```typescript
interface MessageProcessor {
  processMessage(message: Discord.Message): Promise<void>;
  generateEmbedding(text: string): Promise<Float32Array>;
  updateContext(channelId: string, message: Discord.Message): Promise<void>;
}
```

## Key Libraries/Frameworks

### Current Dependencies
- discord.js: ^14.x
- typeorm: ^0.x
- markov-strings-db: Custom fork
- sqlite3: ^5.x

### New Dependencies
```json
{
  "dependencies": {
    "@openai/api": "^4.x",
    "onnxruntime-node": "^1.x",
    "sentence-transformers": "^2.x",
    "sqlite-vss": "^0.1.x",
    "redis": "^4.x"
  }
}
```

## Infrastructure Choices

### Deployment
- Continue with current deployment pattern
- Add environment variables for LLM configuration
- Optional Redis for high-traffic servers

### Scaling Considerations
1. Message Processing
   - Batch embedding generation
   - Background processing queue
   - Rate limiting for API calls

2. Response Generation
   - Caching frequent responses
   - Fallback to Markov when rate limited
   - Load balancing between providers

3. Storage
   - Regular embedding pruning
   - Context window management
   - Backup strategy for embeddings

## Technical Constraints

### API Limitations
1. OpenAI
   - Rate limits
   - Token quotas
   - Cost considerations

2. Discord
   - Message rate limits
   - Response time requirements
   - Attachment handling

### Resource Usage
1. Memory
   - Embedding model size
   - Context window storage
   - Cache management

2. Storage
   - Embedding data size
   - Context history retention
   - Backup requirements

3. Processing
   - Embedding generation load
   - Response generation time
   - Background task management

## Development Environment

### Setup Requirements
```bash
# Core dependencies
npm install

# LLM integration
npm install @openai/api onnxruntime-node sentence-transformers sqlite-vss

# Optional caching
npm install redis
```

### Environment Variables
```env
# LLM Configuration
OPENAI_API_KEY=sk-...
LLM_PROVIDER=openai
LLM_MODEL=gpt-3.5-turbo
LLM_MAX_TOKENS=150
LLM_TEMPERATURE=0.7
CONTEXT_WINDOW_SIZE=10

# Optional Redis
REDIS_URL=redis://localhost:6379
```

### Testing Strategy
1. Unit Tests
   - Message processing
   - Embedding generation
   - Context management

2. Integration Tests
   - LLM API interaction
   - Database operations
   - Discord event handling

3. Performance Tests
   - Response time benchmarks
   - Memory usage monitoring
   - Rate limit compliance