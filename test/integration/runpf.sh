# Usage: bash test/integration/runpf.sh test/integration/pf.mjs   (needs FerretDB or MongoDB on :27017; edit the two FerretDB lines below)
cd /tmp/ferret && rm -rf data && mkdir -p data
nohup ./ferretdb --handler=sqlite --sqlite-url=file:/tmp/ferret/data/ --listen-addr=127.0.0.1:27017 --telemetry=disable --debug-addr=- > ferret.log 2>&1 &
echo $! > /tmp/ferret.pid
node "$(dirname "$0")/fakepf.mjs" > /tmp/fakepf.log 2>&1 &
echo $! > /tmp/fakepf.pid
sleep 2
cd "$(dirname "$0")/../.." && rm -rf data
export DATA_DIR="$PWD/data" MONGODB_URI=mongodb://127.0.0.1:27017/aurelune PORT=3000 SEED_DEMO=true
export POSTFILE_API_KEYS="k1,k2,k3" POSTFILE_API_BASE=http://127.0.0.1:4010 POSTFILE_PART_MB=6 POSTFILE_MAX_MB=50 STORAGE_DRIVER=postfile $EXTRA_ENV
node server/index.js > /tmp/server.log 2>&1 &
echo $! > /tmp/server.pid
for i in $(seq 1 90); do grep -q "listening on" /tmp/server.log 2>/dev/null && break; sleep 2; done
case "$1" in *.mjs) node "$OLDPWD/$1" 2>/dev/null || node "$1";; *) python3 "$1";; esac
kill $(cat /tmp/server.pid) $(cat /tmp/ferret.pid) $(cat /tmp/fakepf.pid) 2>/dev/null
