# System Patterns
Last Updated: 2024-12-27

## High-level Architecture

### Current System
```
Discord Events -> Message Processing -> SQLite Storage
                                   -> Markov Generation
```

### Proposed LLM Integration
```
Discord Events -> Message Processing -> SQLite Storage
                                   -> Response Generator
                                      ├─ Markov Chain
                                      ├─ LLM
                                      └─ Response Selector
```

## Core Technical Patterns

### Data Storage
- SQLite database using TypeORM
- Entity structure:
  - Guild (server)
  - Channel (per-server channels)
  - Messages (training data)

### Message Processing
1. Current Flow:
   - Message received
   - Filtered for human authorship
   - Stored in database with metadata
   - Used for Markov chain training

2. Enhanced Flow:
   - Add message embedding generation
   - Store context window
   - Track conversation threads

### Response Generation

#### Current (Markov)
```typescript
interface MarkovGenerateOptions {
  filter: (result) => boolean;
  maxTries: number;
  startSeed?: string;
}
```

#### Proposed (Hybrid)
```typescript
interface ResponseGenerateOptions {
  contextWindow: Message[];
  temperature: number;
  maxTokens: number;
  startSeed?: string;
  forceProvider?: 'markov' | 'llm' | 'hybrid';
}
```

## Data Flow

### Training Pipeline
1. Message Collection
   - Discord channel history
   - JSON imports
   - Real-time messages

2. Processing
   - Text cleaning
   - Metadata extraction
   - Embedding generation

3. Storage
   - Raw messages
   - Processed embeddings
   - Context relationships

### Response Pipeline
1. Context Gathering
   - Recent messages
   - Channel history
   - User interaction history

2. Generation Strategy
   - Short responses: Markov chain
   - Complex responses: LLM
   - Hybrid: LLM-guided Markov chain

3. Post-processing
   - Response filtering
   - Token limit enforcement
   - Attachment handling

## Key Technical Decisions

### LLM Integration
1. Local Embedding Model
   - Use sentence-transformers for message embedding
   - Store embeddings in SQLite
   - Enable semantic search

2. Response Generation
   - Primary: Use OpenAI API
   - Fallback: Use local LLM
   - Hybrid: Combine with Markov output

3. Context Management
   - Rolling window of recent messages
   - Semantic clustering of related content
   - Thread-aware context tracking

### Performance Requirements
1. Response Time
   - Markov: < 100ms
   - LLM: < 2000ms
   - Hybrid: < 2500ms

2. Memory Usage
   - Max 1GB per guild
   - Batch processing for large imports
   - Regular cleanup of old contexts

3. Rate Limiting
   - Discord API compliance
   - LLM API quota management
   - Fallback mechanisms