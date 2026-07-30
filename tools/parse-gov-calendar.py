"""從人事行政總處的「政府行政機關辦公日曆表」xlsx 解析出平日放假與週末補班的日期。

用途：每年產生 public/index.html 裡 BUILTIN_HOLIDAYS 的內容。

  1. 到 https://www.dgpa.gov.tw/informationlist?uid=30 下載該年度的「辦公日曆表.xlsx」
  2. python3 tools/parse-gov-calendar.py <下載的檔案> --json
  3. 把輸出貼進 index.html 的 BUILTIN_HOLIDAYS

**刻意不讓前端在執行時去抓那個網站**：跨網域會被 CORS 擋、離線就失效，
而且會讓「零外部相依、單檔可開啟」的前提破功。寧可每年手動跑一次這支腳本。

解析方式：那份檔案是給人看的月曆版面，放假與否沒有任何文字標籤，只能靠
**粉紅底色（FFFF99FF）** 判讀。因此它對檔案格式的改變很敏感——腳本內建了
數個 assert，格式一變會直接報錯，而不是安靜地產出錯誤的日期。

已知的坑：十一月與十二月的標題在檔案裡被拆成兩個儲存格（'十'+'一'、'十'+'二'）。
若只取「月」之前最後一個中文數字，十一月會被讀成一月、十二月讀成二月，
產出的日期全都合法卻完全錯誤。
"""
import zipfile, sys, re, datetime
from xml.etree import ElementTree as ET

NS = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
CN = {'一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9,'十':10,'十一':11,'十二':12}
CN_CHARS = set('一二三四五六七八九十')   # 拆成單字的月份標題（十一、十二）也要收得到

def col_index(ref):
    letters = re.match(r'([A-Z]+)', ref).group(1)
    n = 0
    for ch in letters: n = n*26 + (ord(ch)-64)
    return n

def parse(path):
    z = zipfile.ZipFile(path)
    st = ET.fromstring(z.read('xl/styles.xml'))
    fills = []
    for f in st.find(NS+'fills'):
        pf = f.find(NS+'patternFill')
        fg = pf.find(NS+'fgColor') if pf is not None else None
        fills.append((fg.get('rgb') if fg is not None else None))
    xf_fill = [int(x.get('fillId') or 0) for x in st.find(NS+'cellXfs')]
    shared = [''.join(t.text or '' for t in si.iter(NS+'t'))
              for si in ET.fromstring(z.read('xl/sharedStrings.xml'))]
    sheet = ET.fromstring(z.read('xl/worksheets/sheet1.xml'))

    cells = {}
    for row in sheet.iter(NS+'row'):
        r = int(row.get('r'))
        for c in row.iter(NS+'c'):
            v = c.find(NS+'v')
            val = '' if v is None else (v.text or '')
            if c.get('t') == 's': val = shared[int(val)]
            sid = int(c.get('s') or 0)
            cells[(r, col_index(c.get('r')))] = (val.strip(), fills[xf_fill[sid]])

    year = None
    for (r, col), (val, _) in cells.items():
        m = re.search(r'西元(\d{4})年', val)
        if m: year = int(m.group(1)); break
    assert year, '找不到西元年份'

    # 找出每個「N 月」標題所在的列與欄位群組。
    #
    # 月份數字不一定在同一個儲存格裡：十一月與十二月在這份檔案中被拆成兩格
    # （'十' + '一'、'十' + '二'）。只取「月」之前最後一個中文數字的話，
    # 十一月會被讀成一月、十二月被讀成二月，於是十一月的週末會冒充成一月的
    # 國定假日——錯得很隱晦，因為產出的日期本身都合法。
    # 因此改為把「上一個月標題之後、這個月標題之前」的所有數字格串起來再解析。
    blocks = []   # (header_row, month_col, month)
    month_cells = sorted((r, c) for (r, c), (v, _) in cells.items() if v == '月')
    prev_row, prev_col = None, 0
    for r, col in month_cells:
        if r != prev_row: prev_col = 0
        parts = [(c2, v2) for (r2, c2), (v2, _) in cells.items()
                 if r2 == r and prev_col < c2 < col and v2 in CN_CHARS]
        prev_row, prev_col = r, col
        if not parts: continue
        text = ''.join(v for _, v in sorted(parts))
        month = CN.get(text)
        assert month, f'無法解析月份「{text}」（第 {r} 列）'
        blocks.append((r, min(c for c, _ in parts), month))
    blocks.sort()
    assert len(blocks) == 12, f'應該要有 12 個月，實際解析出 {len(blocks)} 個'
    assert sorted(b[2] for b in blocks) == list(range(1, 13)), \
        f'月份不連續：{sorted(b[2] for b in blocks)}'

    header_rows = sorted({b[0] for b in blocks})
    holidays, workdays = [], []
    for hr, mcol, month in blocks:
        nxt = min([h for h in header_rows if h > hr], default=10**6)
        # 該月的欄位範圍：由星期標題列（hr+1）推出，「日」到「六」共 7 欄
        wk = sorted(c for (r, c), (v, _) in cells.items() if r == hr+1 and v == '日')
        start = max([c for c in wk if c <= mcol+2], default=None)
        assert start is not None, f'{month} 月找不到星期標題'
        for r in range(hr+2, nxt):
            for c in range(start, start+7):
                val, fill = cells.get((r, c), ('', None))
                if not re.fullmatch(r'\d{1,2}', val): continue
                day = int(val)
                try: date = datetime.date(year, month, day)
                except ValueError: continue
                off = (date.isoweekday() >= 6)          # 週六日
                if fill == 'FFFF99FF':
                    if not off: holidays.append(date)   # 平日放假 → 需要加進自訂假日
                else:
                    if off: workdays.append(date)       # 週末上班（補班日）
    return year, sorted(set(holidays)), sorted(set(workdays))

if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    year, hol, work = parse(args[0])
    if '--json' in sys.argv:
        print('    ' + str(year) + ': [')
        for i in range(0, len(hol), 4):
            print('      ' + ' '.join(f"'{d.isoformat()}'," for d in hol[i:i+4]))
        print('    ],')
        if work:
            print('    // 注意：這一年有週末補班日，本系統目前無法表達（見已知限制）：')
            print('    // ' + ', '.join(d.isoformat() for d in work))
        raise SystemExit
    print(f'年度：{year}')
    print(f'\n平日放假（需加入自訂假日）共 {len(hol)} 天：')
    for d in hol: print('  ', d.isoformat(), '（週'+'一二三四五六日'[d.isoweekday()-1]+'）')
    print(f'\n週末補班（週六日但要上班）共 {len(work)} 天：')
    for d in work: print('  ', d.isoformat(), '（週'+'一二三四五六日'[d.isoweekday()-1]+'）')
