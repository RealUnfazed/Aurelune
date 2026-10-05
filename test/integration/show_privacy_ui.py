import random, time
from playwright.sync_api import sync_playwright
BASE='http://127.0.0.1:3000'; API=BASE+'/api/v1'
rid=''.join(random.choice('abcdefghijklmnopqrstuvwxyz') for _ in range(5))
ok=bad=0
def ck(n,c,x=''):
    global ok,bad
    ok+=bool(c); bad+=not c; print(('PASS ' if c else 'FAIL ')+n+('' if c else ' '+str(x)))
with sync_playwright() as p:
    b=p.chromium.launch()
    admin=b.new_context(); admin.request.post(API+'/auth/login',data={'login':'admin@aurelune.local','password':'aurelune-admin'})
    def signup(u):
        c=b.new_context(viewport={'width':1366,'height':900}); r=c.request.post(API+'/auth/signup',data={'username':u,'email':u+'@t.test','password':'password123'}); assert r.status==201; return c
    owner=signup('su'+rid); other=signup('sv'+rid)
    r=owner.request.post(API+'/studio/request',data={'name':'Uiband'+rid,'focus':'both'}); cr=r.json()['creator']
    admin.request.post(API+f"/admin/creators/{cr['id']}/approve",data={})
    errs=[]
    pg=owner.new_page(); pg.on('pageerror',lambda e:errs.append(str(e))); pg.goto(BASE+'/#/studio'); 
    pg.wait_for_selector('.tabs',timeout=20000)
    pg.click('.tabs >> text=Podcasts'); pg.click('#new-show')
    pg.wait_for_selector('#sf-public')
    ck('podcast form has a Public switch, on by default', 'on' in pg.get_attribute('#sf-public','class'))
    pg.fill('#sf-title','Hidden gem '+rid); pg.click('#sf-public')
    ck('switch can be turned off', 'on' not in pg.get_attribute('#sf-public','class'))
    pg.click('#sf-save'); pg.wait_for_selector('#shows-list .callout',timeout=10000)
    row=pg.locator('#shows-list .callout').first
    ck('studio row shows a lock for the private podcast', row.locator('.lock-badge').count()==1)
    ck('studio row has a Private pill', 'Private' in row.locator('.vis-pill').inner_text())
    ck('studio row explains there is no episode yet', 'episode' in row.inner_text())
    # flip public via pill
    row.locator('.vis-pill').click(); pg.wait_for_function("document.querySelector('#shows-list .vis-pill')?.classList.contains('public')",timeout=8000)
    ck('pill toggles the podcast to Public', True)
    row=pg.locator('#shows-list .callout').first
    ck('lock gone after making it public', row.locator('.lock-badge').count()==0)
    ck('hint: listeners cannot see it until it has an episode', "can't see" in row.inner_text(), row.inner_text())
    # home for owner: card with "No episodes yet"; other: not there
    pg.goto(BASE+'/#/'); pg.wait_for_selector('.card',timeout=15000); pg.wait_for_timeout(800)
    card=pg.locator('.card', has_text='Hidden gem '+rid)
    ck('owner sees the empty podcast on home, labelled', card.count()==1 and 'No episodes yet' in card.inner_text(), card.count())
    op=other.new_page(); op.goto(BASE+'/#/'); op.wait_for_selector('.card',timeout=15000); op.wait_for_timeout(800)
    ck('another listener does not see it on home', op.locator('.card', has_text='Hidden gem '+rid).count()==0)
    # make private again, owner card has lock
    pg.goto(BASE+'/#/studio'); pg.wait_for_selector('.tabs'); pg.click('.tabs >> text=Podcasts'); pg.wait_for_selector('#shows-list .callout')
    pg.click('[data-edit-show]'); pg.wait_for_selector('#sf-public'); ck('edit form reflects Public', 'on' in pg.get_attribute('#sf-public','class'))
    pg.click('#sf-public'); pg.click('#sf-save'); pg.wait_for_selector('#shows-list .lock-badge',timeout=8000)
    pg.goto(BASE+'/#/'); pg.wait_for_selector('.card'); pg.wait_for_timeout(800)
    card=pg.locator('.card', has_text='Hidden gem '+rid)
    ck('owner home card now has the lock', card.count()==1 and card.locator('.lock-badge').count()==1)
    # ---- API token removal (the reported crash)
    pg.goto(BASE+'/#/settings/developer'); pg.wait_for_selector('#new-token',timeout=10000)
    pg.click('#new-token'); pg.fill('#t-name','temp '+rid); pg.locator('.scope-opt input').first.check(); pg.click('#t-create')
    pg.wait_for_selector('.token-secret',timeout=8000); pg.click('.modal [data-close]'); pg.wait_for_selector('.token-row',timeout=8000)
    n=pg.locator('.token-row').count(); ck('token created', n==1, n)
    pg.click('[data-revoke]'); pg.wait_for_selector('[data-ok]'); pg.click('[data-ok]')
    pg.wait_for_function("document.querySelectorAll('.token-row').length===0",timeout=8000)
    ck('token removed with no error', pg.locator('.token-row').count()==0)
    ck('no uncaught page errors', not errs, errs)
    b.close()
print(ok,'passed',bad,'failed')
