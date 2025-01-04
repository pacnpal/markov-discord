import json
import os
import re
from glob import glob
import argparse

def strip_mentions(content):
    # Pattern for Discord mentions: <@!?[0-9]+> or <@&[0-9]+> or <#[0-9]+>
    mention_pattern = r'<@!?\d+>|<@&\d+>|<#\d+>'
    return re.sub(mention_pattern, '', content).strip()

def extract_channel_name(filename):
    # Extract channel name and part number from Discord export filename format
    # Pattern: channel name before [numbers] and optional [part X]
    channel_match = re.search(r'- ([^[\]]+) \[\d+\]', filename)
    part_match = re.search(r'\[part (\d+)\]', filename, re.IGNORECASE)
    
    if channel_match:
        channel_name = channel_match.group(1).strip().lower()
        # Remove any category names (text after last hyphen)
        channel_name = channel_name.split(' - ')[-1].strip()
        
        # Add part number if it exists
        if part_match:
            part_num = part_match.group(1)
            return f"{channel_name}_part{part_num}.json"
        return f"{channel_name}.json"
    
    return "unknown_channel.json"

def parse_discord_export(input_file, output_dir):
    # Generate output filename based on channel name
    output_filename = extract_channel_name(input_file)
    output_file = os.path.join(output_dir, output_filename)
    
    try:
        # Read the input file
        with open(input_file, 'r', encoding='utf-8') as f:
            data = json.load(f)

        # Extract just the messages and their attachments
        output_messages = []
        
        for msg in data['messages']:
            # Skip empty messages after stripping mentions
            stripped_content = strip_mentions(msg['content'])
            if not stripped_content and not msg['attachments']:
                continue
                
            message_obj = {
                'message': stripped_content
            }
            
            # If there are attachments, add them to the message object
            if msg['attachments']:
                message_obj['attachments'] = [
                    attachment['url'] for attachment in msg['attachments']
                ]
                
            # Only add messages that have content or attachments
            if message_obj['message'] or 'attachments' in message_obj:
                output_messages.append(message_obj)

        # Create output directory if it doesn't exist
        os.makedirs(output_dir, exist_ok=True)

        # Write the output file
        with open(output_file, 'w', encoding='utf-8') as f:
            json.dump(output_messages, f, indent=4, ensure_ascii=False)
            
        print(f"Successfully parsed: {input_file} -> {output_file}")
        return True
        
    except Exception as e:
        print(f"Error processing {input_file}: {str(e)}")
        return False

def process_directory(input_dir, output_dir):
    # Find all Discord export JSON files in the input directory
    pattern = os.path.join(input_dir, "*Discord*.json")
    files = glob(pattern)
    
    if not files:
        print(f"No Discord export files found in: {input_dir}")
        return
    
    success_count = 0
    failure_count = 0
    
    for file in files:
        if parse_discord_export(file, output_dir):
            success_count += 1
        else:
            failure_count += 1
    
    print("\nProcessing complete:")
    print(f"Successfully processed: {success_count} files")
    print(f"Failed to process: {failure_count} files")

def main():
    parser = argparse.ArgumentParser(description='Process Discord export JSON files.')
    parser.add_argument('-i', '--input', default='.',
                        help='Input directory containing Discord export files (default: current directory)')
    parser.add_argument('-o', '--output', default='output',
                        help='Output directory for processed files (default: output)')
    
    args = parser.parse_args()
    
    # Convert to absolute paths
    input_dir = os.path.abspath(args.input)
    output_dir = os.path.abspath(args.output)
    
    # Check if input directory exists
    if not os.path.exists(input_dir):
        print(f"Error: Input directory does not exist: {input_dir}")
        return
    
    print(f"Processing files from: {input_dir}")
    print(f"Saving output to: {output_dir}")
    
    process_directory(input_dir, output_dir)

if __name__ == "__main__":
    main()
