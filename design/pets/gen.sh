#!/usr/bin/env bash
# 夥伴的 AI 圖：產生腳本（開發用，不會被部署——design/ 不在 public/ 底下）
#
# 金鑰：不寫在這裡。雲端工作環境的 Network secrets 已經存了 api.openai.com 的 key，
# 代理會自動把 Authorization 換成真的，所以這裡送 "Bearer dummy" 就好。
# 在自己的電腦上跑的話：export OPENAI_API_KEY=... 然後把 dummy 換成 $OPENAI_API_KEY。
#
# 用法：
#   bash design/pets/gen.sh adult  <輸出.png> "<這一隻的長相描述>"
#   bash design/pets/gen.sh edit   <參考.png> <輸出.png> "<這一張要什麼姿勢／年紀／表情>"
#
# 為什麼是 gpt-image-1.5：它支援 background=transparent。gpt-image-2 回
# "Transparent background is not supported for this model"，透明背景是放進卡片的前提。
# 為什麼先畫成年、再用 edits 往回畫：用同一張參考圖，條紋、腮紅、眼睛才會一致，
# 看得出是「同一隻」。各自從頭生的話每一張都是不同的貓。
set -euo pipefail
KEY="${OPENAI_API_KEY:-dummy}"
MODEL=gpt-image-1.5
# 每次一個自己的暫存檔：同時跑好幾隻時共用 /tmp/gen.json 會互相蓋掉
TMP="$(mktemp)"

STYLE="Needle-felted wool figurine, soft fuzzy wool fibers clearly visible, gentle rounded shapes, warm natural coloring only (no green accents), cozy healing Japanese zakka style, single character centered and filling most of the frame, full body, facing the viewer, cute, no text, no props, no background, soft even studio lighting."
# 植物（冷杉、松樹）本來就是綠的：上面那條「不要綠色」是為了動物的尾巴不長綠毛，
# 對樹不適用。PLANT=1 時換成允許綠色針葉、其餘一樣的寫法。
if [ "${PLANT:-}" = 1 ]; then
  STYLE="Needle-felted wool figurine, soft fuzzy wool fibers clearly visible, gentle rounded shapes, soft natural muted colors (deep muted green needles, warm brown trunk), cozy healing Japanese zakka style, a single small tree in a tiny felt mound of soil, centered and filling most of the frame, cute, no text, no pot, no props, no background, soft even studio lighting."
fi
KEEP="This must be the SAME character as the reference image: identical needle-felted wool material and fiber texture, identical fur colors and markings, same face (eyes, nose, cheeks), same art style and soft lighting. Only the age, pose or expression changes. Single character centered, full body, no text, no props, no background, transparent background."

# 樹沒有臉：上面那句 KEEP 的「same face」會讓小樹苗長出眼睛（第一次就長出一張狐狸臉）
if [ "${PLANT:-}" = 1 ]; then
  KEEP="This must be the SAME kind of tree as the reference image: identical needle-felted wool material and fiber texture, same needle colors and trunk color, same felt soil mound, same art style and soft lighting. Only the age and size of the plant changes. It is a plain plant: NO face, NO eyes, NO mouth, no animal. Single plant centered, no text, no props, no pot, no background, transparent background."
fi
case "$1" in
  adult)
    out="$2"; desc="$3"
    curl -s https://api.openai.com/v1/images/generations \
      -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
      -d "$(jq -n --arg m "$MODEL" --arg p "$desc $STYLE" \
            '{model:$m,prompt:$p,size:"1024x1024",quality:"high",background:"transparent",output_format:"png"}')" \
      | tee "$TMP" | jq -r '.data[0].b64_json' | base64 -d > "$out"
    ;;
  edit)
    ref="$2"; out="$3"; desc="$4"
    curl -s https://api.openai.com/v1/images/edits -H "Authorization: Bearer $KEY" \
      -F model=$MODEL -F "image=@$ref;type=image/${ref##*.}" -F background=transparent -F output_format=png \
      -F size=1024x1024 -F quality=high --form-string "prompt=$desc $KEEP" \
      | tee "$TMP" | jq -r '.data[0].b64_json' | base64 -d > "$out"
    ;;
  *) echo "用法見檔案開頭" >&2; exit 1 ;;
esac
jq -r '.error.message // empty' "$TMP" >&2 || true; rm -f "$TMP"
ls -la "$out"
