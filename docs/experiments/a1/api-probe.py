import json, urllib.request, threading
root = 'http://127.0.0.1:4097'
def req(path, data=None, timeout=20):
    request = urllib.request.Request(root + path, data=None if data is None else json.dumps(data).encode(), headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=timeout) as r:
        body = r.read()
        return {'status': r.status, 'body': json.loads(body) if body else None}
req('/config/providers') # Prime provider initialization before testing cancellation.
lines=[]
def stream():
    try:
        with urllib.request.urlopen(root + '/event', timeout=3) as r:
            while True:
                raw = r.readline()
                if not raw: break
                line=raw.decode().strip()
                if not line: continue
                if line.startswith('data:'): lines.append(json.loads(line[5:]))
    except TimeoutError: pass # End the bounded diagnostic SSE subscription.
thread=threading.Thread(target=stream, daemon=True)
thread.start()
s=req('/session', {'title':'A1 warmed API timeout'})['body']['id']
result={'sessionID':s}
try:
    result['request']=req('/session/'+s+'/message', {'model':{'providerID':'ollama','modelID':'local'},'agent':'build','parts':[{'type':'text','text':'Without tools explain JavaScript testing in 1000 words.'}]}, timeout=0.05)
except TimeoutError:
    result['clientTimeout']=True
result['statusAfterClientTimeout']=req('/session/status')
result['abort']=req('/session/'+s+'/abort', {})
result['statusAfterAbort']=req('/session/status')
result['providersAfterAbort']=[x['id'] for x in req('/config/providers')['body']['providers']]
result['resumed']=req('/session/'+s+'/message', {'model':{'providerID':'ollama','modelID':'local'},'agent':'build','parts':[{'type':'text','text':'Cancel the long explanation. Without tools reply A1-API-RESUMED.'}]})
result['events']=[x for x in lines if x.get('properties',{}).get('sessionID')==s or x.get('type')=='server.connected']
open('/tmp/code-foundry-a1/evidence/api-timeout.json','w').write(json.dumps(result,indent=2))
print(json.dumps({k:v for k,v in result.items() if k not in ['resumed','events']},indent=2))
print('resumed status',result['resumed']['status'])
print('resumed text',[x.get('text') for x in result['resumed']['body']['parts'] if x['type']=='text'])
print('SSE event types',sorted(set(x['type'] for x in result['events'])))
