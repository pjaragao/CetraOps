#!/usr/bin/env bash
# Compila o app da maquininha num contêiner (sem Android Studio). Saída em app/build/outputs/apk/.
#   apps/pos-android/scripts/build.sh                 # APK de teste (debug, pacote .dev, simulador da Stone em sandbox)
#   apps/pos-android/scripts/build.sh assembleRelease # APK de produção (assinado se houver keystore.properties)
#   apps/pos-android/scripts/build.sh test            # testes de unidade
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
docker image inspect cetraops-android-build >/dev/null 2>&1 || docker build -t cetraops-android-build -f "$DIR/scripts/Dockerfile.build" "$DIR/scripts"
docker volume create cetraops-gradle-cache >/dev/null
docker run --rm -u "$(id -u):$(id -g)" -e GRADLE_USER_HOME=/gradle -e HOME=/gradle -e ANDROID_USER_HOME=/gradle/.android -v cetraops-gradle-cache:/gradle -v "$DIR":/src -w /src \
  cetraops-android-build ./gradlew --no-daemon -q "${@:-assembleDebug}"
ls -la "$DIR"/app/build/outputs/apk/*/ 2>/dev/null || true
