import json, sys, urllib.request, urllib.parse, time
titles=[l.strip() for l in open(sys.argv[1]) if l.strip()]
out=sys.argv[2]
res={}
for i in range(0,len(titles),40):
    batch=titles[i:i+40]
    q=urllib.parse.urlencode({'action':'query','prop':'revisions','rvprop':'content|ids','rvslots':'main','titles':'|'.join(batch),'format':'json','redirects':1})
    req=urllib.request.Request('https://zenless-zone-zero.fandom.com/api.php?'+q,headers={'User-Agent':'Mozilla/5.0 persona-corpus'})
    for attempt in range(3):
        try:
            d=json.load(urllib.request.urlopen(req,timeout=90)); break
        except Exception as e:
            print('retry',e,file=sys.stderr); time.sleep(3)
    for p in d['query']['pages'].values():
        if 'revisions' in p:
            r=p['revisions'][0]
            res[p['title']]={'revid':r.get('revid'),'text':r['slots']['main']['*']}
    print(i,len(res),file=sys.stderr)
json.dump(res,open(out,'w'),ensure_ascii=False)
