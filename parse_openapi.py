import json
import sys
from collections import defaultdict

with open(r'C:\Users\HP MEDIA\.local\share\opencode\tool-output\tool_dad88babe00188eMm8cHauLTQd', 'r') as f:
    data = json.load(f)

paths = data.get('paths', {})
endpoints = []
for path, methods in paths.items():
    for method, details in methods.items():
        if isinstance(details, dict):
            op_id = details.get('operationId', 'N/A')
            tags = details.get('tags', ['Untagged'])
            has_params = 'parameters' in details
            has_body = 'requestBody' in details
            endpoints.append({
                'path': path,
                'method': method.upper(),
                'operationId': op_id,
                'tags': tags,
                'has_params': has_params,
                'has_body': has_body
            })

# Group by first tag
by_tag = defaultdict(list)
for ep in endpoints:
    tag = ep['tags'][0] if ep['tags'] else 'Untagged'
    by_tag[tag].append(ep)

for tag in sorted(by_tag.keys()):
    print(f'\n=== {tag} ({len(by_tag[tag])} endpoints) ===')
    for ep in by_tag[tag]:
        inputs = []
        if ep['has_params']: inputs.append('query params')
        if ep['has_body']: inputs.append('request body')
        input_str = ', '.join(inputs) if inputs else 'none'
        print(f"  {ep['method']:6} {ep['path']}")
        print(f"         op: {ep['operationId']}")
        print(f"         inputs: {input_str}")

print(f'\n\nTotal endpoints: {len(endpoints)}')
