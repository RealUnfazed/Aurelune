from playwright.sync_api import sync_playwright
BASE='http://127.0.0.1:3000'; API=BASE+'/api/v1'
ok=bad=0
def ck(n,c,x=''):
    global ok,bad
    ok+=bool(c); bad+=not c; print(('PASS ' if c else 'FAIL ')+n+('' if c else ' '+str(x)))
with sync_playwright() as p:
    b=p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
    for label,ua in (('web',None),('desktop','Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130 Electron/44.0.0 Safari/537.36')):
        ctx=b.new_context(viewport={'width':1366,'height':800}, **({'user_agent':ua} if ua else {}))
        r=ctx.request.post(API+'/auth/login',data={'login':'admin@aurelune.local','password':'aurelune-admin'}); assert r.ok
        pg=ctx.new_page(); pg.goto(BASE+'/'); pg.wait_for_selector('[data-play-card]',timeout=20000)
        pg.hover('[data-play-card] >> nth=0'); pg.click('button.play-overlay >> nth=0')
        pg.wait_for_timeout(2500)
        paused=lambda: not pg.evaluate('import("/js/player.js").then(m=>!!m.player.isPlaying)')
        ck(label+': playing', not paused())
        # type in the search box with a space
        pg.click('#topbar-search-input'); pg.keyboard.type('Hello world')
        pg.wait_for_timeout(300)
        ck(label+': search keeps typed space', pg.input_value('#topbar-search-input')=='Hello world', pg.input_value('#topbar-search-input'))
        ck(label+': typing space did NOT pause', not paused())
        # Ctrl+Arrow in a text box must not skip
        t0=pg.evaluate('import("/js/player.js").then(m=>m.player.index)')
        pg.keyboard.press('Control+ArrowRight'); pg.wait_for_timeout(300)
        ck(label+': ctrl+right in textbox did not skip', pg.evaluate('import("/js/player.js").then(m=>m.player.index)')==t0)
        # click on empty page area then Space toggles
        pg.evaluate('document.activeElement.blur()'); pg.keyboard.press('Space'); pg.wait_for_timeout(300)
        ck(label+': space on page pauses', paused())
        pg.keyboard.press('Space'); pg.wait_for_timeout(400)
        ck(label+': space again resumes', not paused())
        # space on a focused button activates button, not a double toggle
        pg.focus('#p-prev'); 
        # selection
        pg.evaluate('getSelection().removeAllRanges()')
        el=pg.locator('.card .title').first; el.dblclick()
        ck(label+': dblclick on title selects nothing', pg.evaluate('getSelection().toString()')=='' , pg.evaluate('getSelection().toString()'))
        pg.keyboard.press('Control+a'); 
        ck(label+': ctrl+a selects nothing', pg.evaluate('getSelection().toString().trim()')=='', pg.evaluate('getSelection().toString()')[:60])
        pg.click('#topbar-search-input'); pg.keyboard.press('Control+a')
        ck(label+': ctrl+a in search selects text', pg.evaluate('getSelection().toString()||document.activeElement.value.slice(document.activeElement.selectionStart,document.activeElement.selectionEnd)')=='Hello world')
        ck(label+': css user-select none on body', pg.evaluate('getComputedStyle(document.body).userSelect')=='none')
        ck(label+': css user-select text on input', pg.evaluate('getComputedStyle(document.getElementById("topbar-search-input")).userSelect')=='text')

        pg.evaluate('document.activeElement.blur()')
        pg.evaluate('import("/js/player.js").then(m=>{window.__n=0;window.__p=0;m.player.next=()=>{window.__n++};m.player.prev=()=>{window.__p++}})'); pg.wait_for_timeout(100)
        pg.keyboard.press('Control+ArrowRight'); pg.keyboard.press('Control+ArrowLeft')
        n,pv=pg.evaluate('[window.__n,window.__p]')
        ck(label+': ctrl+arrows outside inputs -> '+('next/prev' if label=='desktop' else 'ignored on web'), (n,pv)==((1,1) if label=='desktop' else (0,0)), (n,pv))
        pg.click('#topbar-search-input'); pg.keyboard.press('Control+ArrowRight')
        ck(label+': ctrl+right inside search never calls next', pg.evaluate('window.__n')==n)
        ctx.close()
    b.close()
print(ok,'passed',bad,'failed')
