# Launches the real Electron app (needs xvfb on Linux) in client and full mode against a server already running on :3000 and MongoDB on :27017.
# Run: python3 test/integration/desktop_modes.py
import os, subprocess, time, json, sys, shutil, signal
from playwright.sync_api import sync_playwright
ROOT=os.path.abspath(os.path.join(os.path.dirname(__file__),'..','..')); ok=bad=0
def ck(n,c,x=''):
    global ok,bad
    ok+=bool(c); bad+=not c; print(('PASS ' if c else 'FAIL ')+n+('' if c else ' '+str(x)))
PORT=9333
def launch(tag, env):
    ud=f'/tmp/eltest-{tag}'; shutil.rmtree(ud, ignore_errors=True)
    e={**os.environ, **env}
    p=subprocess.Popen(['xvfb-run','-a',f'{ROOT}/node_modules/electron/dist/electron',ROOT,'--no-sandbox','--disable-gpu',f'--remote-debugging-port={PORT}',f'--user-data-dir={ud}'],env=e,stdout=open(f'/tmp/el-{tag}.log','w'),stderr=subprocess.STDOUT,preexec_fn=os.setsid)
    return p, ud
def stop(p):
    try: os.killpg(os.getpgid(p.pid), signal.SIGKILL)
    except Exception: pass
    subprocess.run('pkill -9 -x electron; true',shell=True); time.sleep(1.5)
def page_of(pw):
    for i in range(60):
        try:
            b=pw.chromium.connect_over_cdp(f'http://127.0.0.1:{PORT}')
            for ctx in b.contexts:
                for pg in ctx.pages:
                    if not pg.url.startswith('devtools'): return b,pg
        except Exception: pass
        time.sleep(1)
    raise RuntimeError('no electron page')
def ps_has_server():
    out=subprocess.run("ps aux | grep -E 'server/index.js' | grep -v grep | grep -v 'node server/index.js' | wc -l",shell=True,capture_output=True,text=True).stdout.strip()
    return int(out or 0)
with sync_playwright() as pw:
    # 1. client mode with the address baked in via env
    p,ud=launch('c1',{'AURELUNE_MODE':'client','AURELUNE_SERVER_URL':'http://127.0.0.1:3000'})
    b,pg=page_of(pw)
    try:
        pg.wait_for_selector('.nav, #app',timeout=30000); pg.wait_for_timeout(1500)
        ck('client mode opens the remote server', pg.url.startswith('http://127.0.0.1:3000'), pg.url)
        ck('the web client rendered', pg.locator('.nav').count()>0 or pg.locator('#app').count()>0)
        ck('no server process started inside the app (nothing on 4173)', subprocess.run('curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:4173/api/v1/session',shell=True,capture_output=True,text=True).stdout.strip()=='000')
        ck('UA says Electron (so desktop-only shortcuts apply)', 'Electron/' in pg.evaluate('navigator.userAgent'))
        ck('connect bridge NOT exposed to the remote site', pg.evaluate('typeof window.aureluneDesktop')=='undefined')
    finally: b.close(); stop(p)
    # 2. client mode, nothing configured: connect screen -> type address
    p,ud=launch('c2',{'AURELUNE_MODE':'client','AURELUNE_SERVER_URL':''})
    b,pg=page_of(pw)
    try:
        pg.wait_for_selector('#url',timeout=30000)
        ck('no address: the connect screen is shown', pg.url.startswith('file:') and 'Connect to your server' in pg.inner_text('body'))
        ck('bridge exposed on the local screen', pg.evaluate('typeof window.aureluneDesktop?.connect')=='function')
        pg.fill('#url','nonsense url with spaces'); pg.click('#go'); pg.wait_for_timeout(1500)
        ck('a bad address shows an error and stays', pg.locator('#err.on').count()==1, pg.inner_text('#err'))
        pg.fill('#url','127.0.0.1:1'); pg.click('#go'); pg.wait_for_selector('#err.on',timeout=15000); pg.wait_for_timeout(500)
        ck('an unreachable server shows a clear error', 'reach' in pg.inner_text('#err').lower(), pg.inner_text('#err'))
        pg.fill('#url','127.0.0.1:3000'); pg.click('#go'); pg.wait_for_url('http://127.0.0.1:3000/**',timeout=20000); pg.wait_for_selector('.nav, #app',timeout=20000)
        ck('a good address (typed without http://) connects', pg.url.startswith('http://127.0.0.1:3000'))
        ck('the address was saved', os.path.exists(ud+'/server.json') and json.load(open(ud+'/server.json'))['url']=='http://127.0.0.1:3000', os.listdir(ud)[:10])
    finally: b.close(); stop(p)
    # 3. relaunch with the saved address and no env: goes straight there
    saved=ud
    p=subprocess.Popen(['xvfb-run','-a',f'{ROOT}/node_modules/electron/dist/electron',ROOT,'--no-sandbox','--disable-gpu',f'--remote-debugging-port={PORT}',f'--user-data-dir={saved}'],env={**os.environ,'AURELUNE_MODE':'client','AURELUNE_SERVER_URL':''},stdout=open('/tmp/el-c3.log','w'),stderr=subprocess.STDOUT,preexec_fn=os.setsid)
    b,pg=page_of(pw)
    try:
        pg.wait_for_selector('.nav, #app',timeout=30000); pg.wait_for_timeout(1000)
        ck('next launch goes straight to the saved server', pg.url.startswith('http://127.0.0.1:3000'), pg.url)
    finally: b.close(); stop(p)
    # 4. saved/baked address that is down -> error screen with the address prefilled
    p,ud=launch('c4',{'AURELUNE_MODE':'client','AURELUNE_SERVER_URL':'http://127.0.0.1:1'})
    b,pg=page_of(pw)
    try:
        pg.wait_for_selector('#url',timeout=30000); pg.wait_for_timeout(500)
        ck('server down: connect screen with the reason and the address filled in', pg.input_value('#url')=='http://127.0.0.1:1' and pg.locator('#err.on').count()==1, (pg.input_value('#url'), pg.locator('#err').inner_text()))
    finally: b.close(); stop(p)
    # 5. full mode: starts its own server (MongoDB from FerretDB) and opens it
    p,ud=launch('f1',{'AURELUNE_MODE':'full','AURELUNE_PORT':'4173','AURELUNE_SEED_DEMO':'false','AURELUNE_MONGODB_URI':'mongodb://127.0.0.1:27017/aurelune_full'})
    b,pg=page_of(pw)
    try:
        pg.wait_for_url('http://127.0.0.1:4173/**',timeout=90000); pg.wait_for_selector('#app',timeout=30000); pg.wait_for_timeout(1000)
        ck('full mode runs its own local server and opens it', pg.url.startswith('http://127.0.0.1:4173'), pg.url)
        ck('full mode: server API answers on 4173', subprocess.run('curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:4173/api/v1/session',shell=True,capture_output=True,text=True).stdout.strip()=='200')
        ck('connect bridge not exposed in full mode', pg.evaluate('typeof window.aureluneDesktop')=='undefined')
    finally: b.close(); stop(p)
    # 6. LOCKED client build (built with --server): no server options, every override ignored
    cfgp=ROOT+'/electron/build-config.json'; orig=open(cfgp).read()
    try:
        open(cfgp,'w').write(json.dumps({'mode':'client','serverUrl':'http://127.0.0.1:3000'}))
        ud='/tmp/eltest-l1'; shutil.rmtree(ud,ignore_errors=True); os.makedirs(ud)
        json.dump({'url':'http://127.0.0.1:9'},open(ud+'/server.json','w'))   # a saved address that must be ignored
        e={**os.environ,'AURELUNE_MODE':'full','AURELUNE_SERVER_URL':'http://127.0.0.1:1'}
        p=subprocess.Popen(['xvfb-run','-a',f'{ROOT}/node_modules/electron/dist/electron',ROOT,'--mode=full','--server=http://127.0.0.1:2','--no-sandbox','--disable-gpu',f'--remote-debugging-port={PORT}',f'--user-data-dir={ud}'],env=e,stdout=open('/tmp/el-l1.log','w'),stderr=subprocess.STDOUT,preexec_fn=os.setsid)
        b,pg=page_of(pw)
        try:
            pg.wait_for_selector('.nav, #app',timeout=30000); pg.wait_for_timeout(1000)
            ck('locked: opens its own server, ignoring env/argv/saved address and --mode=full', pg.url.startswith('http://127.0.0.1:3000'), pg.url)
            ck('locked: no local server started', subprocess.run('curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:4173/api/v1/session',shell=True,capture_output=True,text=True).stdout.strip()=='000')
            ck('locked: saved address untouched', json.load(open(ud+'/server.json'))['url']=='http://127.0.0.1:9')
        finally: b.close(); stop(p)
        # server unreachable: an error screen with NO address box and no way to point elsewhere
        open(cfgp,'w').write(json.dumps({'mode':'client','serverUrl':'http://127.0.0.1:1'}))
        p,ud=launch('l2',{'AURELUNE_SERVER_URL':'http://127.0.0.1:3000'})
        b,pg=page_of(pw)
        try:
            pg.wait_for_selector('#err.on',timeout=30000); pg.wait_for_timeout(400)
            ck('locked + server down: error screen shows', pg.url.startswith('file:') and 'reach' in pg.inner_text('#err').lower(), pg.inner_text('body')[:200])
            ck('locked: there is no address field', pg.locator('#url').count()==0 and pg.locator('input').count()==0)
            ck('locked: no "Server menu" hint', 'Server' not in pg.locator('body').inner_text().replace('server','').replace('Server is','') or pg.locator('#hint').count()==0)
            ck('locked: only Try again + Quit', pg.locator('button').count()==2 and pg.inner_text('#go')=='Try again')
            r=pg.evaluate('window.aureluneDesktop.connect("http://127.0.0.1:3000")')
            ck('locked: the connect call is refused by the app', r and r.get('ok') is False, r)
            pg.wait_for_timeout(800)
            ck('locked: …and nothing navigated', pg.url.startswith('file:'), pg.url)
            pg.click('#go'); pg.wait_for_timeout(2500)
            ck('locked: Try again retries the same (down) server, still the error screen', pg.url.startswith('file:') and pg.locator('#err.on').count()==1, pg.url)
        finally: b.close(); stop(p)
    finally:
        open(cfgp,'w').write(orig)
print(ok,'passed',bad,'failed')
