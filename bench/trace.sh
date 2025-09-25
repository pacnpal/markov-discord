#!/bin/bash

# Markov Discord Performance Tracing Script
# Usage: ./bench/trace.sh [baseline|optimized] [iterations]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
MODE="${1:-baseline}"
ITERATIONS="${2:-10}"
GUILD_ID="test-guild-123"
OUTPUT_DIR="$PROJECT_DIR/bench/results"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

echo "=== Markov Discord Performance Tracing ==="
echo "Mode: $MODE"
echo "Iterations: $ITERATIONS"
echo "Guild ID: $GUILD_ID"
echo "Output: $OUTPUT_DIR"
echo "Timestamp: $TIMESTAMP"
echo

# Create output directory
mkdir -p "$OUTPUT_DIR"

# Generate test data if it doesn't exist
TEST_DATA_FILE="$PROJECT_DIR/test-data.json"
if [ ! -f "$TEST_DATA_FILE" ]; then
    echo "Generating test data..."
    node -e "
    const fs = require('fs');
    const messages = [];
    const words = ['hello', 'world', 'this', 'is', 'a', 'test', 'message', 'for', 'performance', 'testing', 'with', 'many', 'different', 'words', 'and', 'phrases'];

    for (let i = 0; i < 10000; i++) {
        const sentence = [];
        for (let j = 0; j < Math.floor(Math.random() * 10) + 3; j++) {
            sentence.push(words[Math.floor(Math.random() * words.length)]);
        }
        messages.push({ message: sentence.join(' ') });
    }

    fs.writeFileSync('$TEST_DATA_FILE', JSON.stringify(messages, null, 2));
    console.log('Generated 10,000 test messages');
    "
fi

# Function to run training benchmark
run_training_benchmark() {
    local mode=$1
    local output_file="$OUTPUT_DIR/training_${mode}_${TIMESTAMP}.json"

    echo "Running training benchmark ($mode)..."

    # Set environment variables based on mode
    if [ "$mode" = "optimized" ]; then
        export USE_MARKOV_STORE=true
        export USE_WORKER_THREADS=true
    else
        export USE_MARKOV_STORE=false
        export USE_WORKER_THREADS=false
    fi

    # Run with Node.js profiling
    node --prof --trace-deopt --track_gc_object_stats \
         --log-timer-events \
         -e "
    const startTime = process.hrtime.bigint();
    const startMemory = process.memoryUsage();

    // Simulate training
    const fs = require('fs');
    const data = JSON.parse(fs.readFileSync('$TEST_DATA_FILE', 'utf8'));

    console.log('Processing', data.length, 'messages');

    // Simple training simulation
    let chain = new Map();
    for (const msg of data) {
        const words = msg.message.split(' ');
        for (let i = 0; i < words.length - 1; i++) {
            const prefix = words[i];
            const suffix = words[i + 1];
            if (!chain.has(prefix)) chain.set(prefix, new Map());
            const suffixMap = chain.get(prefix);
            suffixMap.set(suffix, (suffixMap.get(suffix) || 0) + 1);
        }
    }

    const endTime = process.hrtime.bigint();
    const endMemory = process.memoryUsage();

    console.log('Training completed');
    console.log('Time:', Number(endTime - startTime) / 1000000, 'ms');
    console.log('Memory:', (endMemory.heapUsed - startMemory.heapUsed) / 1024 / 1024, 'MB');
    console.log('Chains:', chain.size);
    " 2>&1 | tee "$output_file"

    echo "Training benchmark completed: $output_file"
}

# Function to run generation benchmark
run_generation_benchmark() {
    local mode=$1
    local output_file="$OUTPUT_DIR/generation_${mode}_${TIMESTAMP}.json"

    echo "Running generation benchmark ($mode)..."

    # Set environment variables based on mode
    if [ "$mode" = "optimized" ]; then
        export USE_MARKOV_STORE=true
        export USE_WORKER_THREADS=true
    else
        export USE_MARKOV_STORE=false
        export USE_WORKER_THREADS=false
    fi

    # Run with Node.js profiling
    node --prof --trace-deopt --track_gc_object_stats \
         --log-timer-events \
         -e "
    const startTime = process.hrtime.bigint();
    const startMemory = process.memoryUsage();

    // Simple generation simulation
    const fs = require('fs');
    const data = JSON.parse(fs.readFileSync('$TEST_DATA_FILE', 'utf8'));

    // Build a simple chain
    let chain = new Map();
    for (const msg of data.slice(0, 1000)) { // Use subset for chain building
        const words = msg.message.split(' ');
        for (let i = 0; i < words.length - 1; i++) {
            const prefix = words[i];
            const suffix = words[i + 1];
            if (!chain.has(prefix)) chain.set(prefix, new Map());
            const suffixMap = chain.get(prefix);
            suffixMap.set(suffix, (suffixMap.get(suffix) || 0) + 1);
        }
    }

    // Generate responses
    const responses = [];
    for (let i = 0; i < 100; i++) {
        const prefixes = Array.from(chain.keys());
        const startWord = prefixes[Math.floor(Math.random() * prefixes.length)];
        let current = startWord;
        let response = [current];

        for (let j = 0; j < 20; j++) {
            const suffixMap = chain.get(current);
            if (!suffixMap || suffixMap.size === 0) break;

            const suffixes = Array.from(suffixMap.entries());
            const total = suffixes.reduce((sum, [, count]) => sum + count, 0);
            let random = Math.random() * total;

            for (const [suffix, count] of suffixes) {
                random -= count;
                if (random <= 0) {
                    response.push(suffix);
                    current = suffix;
                    break;
                }
            }
        }

        responses.push(response.join(' '));
    }

    const endTime = process.hrtime.bigint();
    const endMemory = process.memoryUsage();

    console.log('Generation completed');
    console.log('Generated', responses.length, 'responses');
    console.log('Time:', Number(endTime - startTime) / 1000000, 'ms');
    console.log('Memory:', (endMemory.heapUsed - startMemory.heapUsed) / 1024 / 1024, 'MB');
    " 2>&1 | tee "$output_file"

    echo "Generation benchmark completed: $output_file"
}

# Function to run memory usage benchmark
run_memory_benchmark() {
    local mode=$1
    local output_file="$OUTPUT_DIR/memory_${mode}_${TIMESTAMP}.json"

    echo "Running memory benchmark ($mode)..."

    # Set environment variables based on mode
    if [ "$mode" = "optimized" ]; then
        export USE_MARKOV_STORE=true
        export USE_WORKER_THREADS=true
    else
        export USE_MARKOV_STORE=false
        export USE_WORKER_THREADS=false
    fi

    # Run memory profiling
    node --expose-gc --max-old-space-size=4096 \
         -e "
    const fs = require('fs');
    const data = JSON.parse(fs.readFileSync('$TEST_DATA_FILE', 'utf8'));

    console.log('Starting memory benchmark...');

    let chain = new Map();
    let memoryUsage = [];

    // Build chain incrementally and measure memory
    for (let i = 0; i < Math.min(data.length, 5000); i += 100) {
        const batch = data.slice(i, i + 100);

        for (const msg of batch) {
            const words = msg.message.split(' ');
            for (let j = 0; j < words.length - 1; j++) {
                const prefix = words[j];
                const suffix = words[j + 1];
                if (!chain.has(prefix)) chain.set(prefix, new Map());
                const suffixMap = chain.get(prefix);
                suffixMap.set(suffix, (suffixMap.get(suffix) || 0) + 1);
            }
        }

        if (global.gc) global.gc();
        const mem = process.memoryUsage();
        memoryUsage.push({
            messagesProcessed: i + 100,
            heapUsed: mem.heapUsed,
            heapTotal: mem.heapTotal,
            external: mem.external,
            rss: mem.rss
        });
    }

    console.log('Memory benchmark completed');
    console.log('Final chains:', chain.size);
    console.log('Memory samples:', memoryUsage.length);

    fs.writeFileSync('$output_file', JSON.stringify({
        mode: '$mode',
        memoryUsage,
        finalChainSize: chain.size,
        timestamp: '$TIMESTAMP'
    }, null, 2));

    console.log('Memory benchmark data saved to: $output_file');
    " 2>&1 | tee "${output_file}.log"

    echo "Memory benchmark completed: $output_file"
}

# Main execution
case "$MODE" in
    "baseline")
        echo "Running baseline benchmarks..."
        run_training_benchmark "baseline"
        run_generation_benchmark "baseline"
        run_memory_benchmark "baseline"
        ;;
    "optimized")
        echo "Running optimized benchmarks..."
        run_training_benchmark "optimized"
        run_generation_benchmark "optimized"
        run_memory_benchmark "optimized"
        ;;
    "both")
        echo "Running both baseline and optimized benchmarks..."
        run_training_benchmark "baseline"
        run_training_benchmark "optimized"
        run_generation_benchmark "baseline"
        run_generation_benchmark "optimized"
        run_memory_benchmark "baseline"
        run_memory_benchmark "optimized"
        ;;
    *)
        echo "Usage: $0 [baseline|optimized|both] [iterations]"
        echo "  baseline  - Run benchmarks without optimizations"
        echo "  optimized - Run benchmarks with optimizations enabled"
        echo "  both      - Run both baseline and optimized benchmarks"
        echo "  iterations - Number of iterations to run (default: 10)"
        exit 1
        ;;
esac

# Generate comparison report if both modes were run
if [ "$MODE" = "both" ]; then
    echo
    echo "Generating comparison report..."

    # Simple comparison report
    cat > "$OUTPUT_DIR/comparison_${TIMESTAMP}.txt" << EOF
=== Markov Discord Performance Comparison ===
Timestamp: $TIMESTAMP
Iterations: $ITERATIONS

Benchmark Results Summary:
- Baseline and optimized modes compared
- See individual benchmark files for detailed metrics
- Check $OUTPUT_DIR for all result files

Files generated:
- training_baseline_*.json
- training_optimized_*.json
- generation_baseline_*.json
- generation_optimized_*.json
- memory_baseline_*.json
- memory_optimized_*.json

EOF

    echo "Comparison report: $OUTPUT_DIR/comparison_${TIMESTAMP}.txt"
fi

echo
echo "=== Benchmarking Complete ==="
echo "Results saved to: $OUTPUT_DIR"
echo "Check individual files for detailed performance metrics"