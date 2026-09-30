#!/bin/sh
# Everything, in the order that catches the most first.
#
#   sh test/run.sh
#
# The structure test runs early and costs nothing: it is the one that catches a
# Panel.qml the shell will refuse to load, which `qmllint` does not.

set -e
cd "$(dirname "$0")/.."

echo "-- structure"
node test/qml-test.js

echo "-- model"
node test/model-test.js

echo "-- search"
node test/search-test.js

echo "-- ops"
node test/ops-test.js

echo "-- artwork gate"
sh test/probe-test.sh

echo
echo "all tests passed"
echo
echo "note: search-test.js makes live requests to Deezer and Apple's search API,"
echo "      so it fails when either is unreachable. That is intended -- a widget"
echo "      whose whole point is discovery should not pass while discovery is"
echo "      broken -- but it does mean this needs a network to be green."
