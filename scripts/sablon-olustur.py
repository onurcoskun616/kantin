#!/usr/bin/env python3
"""
Urun listesi ve acilis stogu Excel sablonunu uretir.

Kullanim:  python3 scripts/sablon-olustur.py
Cikti:     docs/sablonlar/urun-listesi-sablonu.xlsx
"""
from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.formatting.rule import CellIsRule
from openpyxl.comments import Comment

ROOT = Path(__file__).resolve().parent.parent
OUTPUTS = [
    ROOT / "docs" / "sablonlar" / "urun-listesi-sablonu.xlsx",
    ROOT / "public" / "sablonlar" / "urun-listesi-sablonu.xlsx",  # uygulamadan indirilebilmesi icin
]
ROWS = 400  # formullerin onceden hazirlandigi satir sayisi

FONT = "Arial"
NAVY = "1E3A8A"
HEADER_FILL = PatternFill("solid", fgColor=NAVY)
INPUT_FILL = PatternFill("solid", fgColor="FFFDE7")     # doldurulacak alanlar
CALC_FILL = PatternFill("solid", fgColor="F1F5F9")      # otomatik hesaplanan
EXAMPLE_FILL = PatternFill("solid", fgColor="E8F5E9")
THIN = Side(style="thin", color="CBD5E1")
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)

CATEGORIES = [
    "Su ve İçecek", "Süt ve Süt Ürünleri", "Sandviç ve Unlu Mamul",
    "Kuruyemiş ve Kuru Meyve", "Bisküvi ve Kek", "Taze Meyve",
    "Sıcak İçecek", "Dondurma", "Kırtasiye", "Diğer",
]
UNITS = ["ADET", "KG", "LT", "PAKET", "KUTU", "PORSIYON"]
PRODUCT_TYPES = ["Satın alınan", "Hammadde", "Üretilen"]
VAT_RATES = [1, 10, 20]
CAMPUSES = [
    ("IKT", "İkitelli OSB Kampüsü"),
    ("IST", "İstanbul OSB Kampüsü"),
    ("ESN", "Esenyurt Kampüsü"),
    ("KRC", "Kıraç Kampüsü"),
    ("CRL", "Çorlu Kampüsü"),
]

PRODUCT_COLUMNS = [
    ("Barkod", 16, "Ürün barkodu. Sayımda barkod okutarak hızlı giriş yapmanızı sağlar. "
                   "Barkodu olmayan ürünler (çay, tost gibi) için boş bırakın."),
    ("Ürün Adı *", 34, "ZORUNLU. Rafta/menüde göründüğü şekilde yazın. Gramaj varsa ekleyin: 'Ayran 200 ml'"),
    ("Kategori", 24, "Listeden seçin. Yeni kategori yazarsanız sisteme otomatik eklenir."),
    ("Birim", 12, "Listeden seçin. Çoğu kantin ürünü ADET'tir."),
    ("Ürün Tipi", 22, "Satın alınan = tedarikçiden gelir, raftan sayılır, doğrudan satılır.\n"
                      "Hammadde = raftan sayılır ama satılmaz; reçetelerde tüketilir (ekmek, kaşar, çay).\n"
                      "Üretilen = kantinde hazırlanır (tost, çay, poğaça). Stoktan ve sayımdan çıkarılır; "
                      "dönem satış adedi sayım ekranında girilir, maliyeti reçetesinden hesaplanır."),
    ("Alış Fiyatı (KDV dahil) *", 22, "ZORUNLU. Faturada ÖDENEN birim fiyat, KDV DAHİL."),
    ("Satış Fiyatı (KDV dahil) *", 22, "ZORUNLU. Öğrenciden tahsil ettiğiniz RAF fiyatı, KDV DAHİL."),
    ("KDV Oranı (%)", 14, "Tedarikçi faturasındaki KDV oranını yazın. Emin değilseniz faturaya bakın."),
    ("Kritik Stok", 12, "Bu miktarın altına inince panel uyarı verir. Haftalık satışın yarısı iyi bir başlangıçtır."),
    ("Tavan Fiyat", 14, "Resmî tarife veya okul kararıyla belirlenen üst sınır. Yoksa boş bırakın."),
    ("Birim Kâr (otomatik)", 18, "OTOMATİK HESAPLANIR - doldurmayın. Satış(KDV hariç) - Alış"),
    ("Kâr Marjı (otomatik)", 18, "OTOMATİK HESAPLANIR - doldurmayın. Birim kâr / KDV hariç satış"),
]

EXAMPLE_ROWS = [
    ["8690000000028", "Ayran 200 ml", "Süt ve Süt Ürünleri", "ADET", "Satın alınan", 8.50, 13.00, 1, 24, 0],
    ["8690000000011", "Su 500 ml", "Su ve İçecek", "ADET", "Satın alınan", 4.00, 6.00, 10, 48, 0],
    ["", "Tost", "Sandviç ve Unlu Mamul", "ADET", "Üretilen", 18.00, 35.00, 10, 0, 0],
]


def style_header(ws, columns, row=1):
    for idx, (title, width, note) in enumerate(columns, start=1):
        cell = ws.cell(row=row, column=idx, value=title)
        cell.font = Font(name=FONT, size=10, bold=True, color="FFFFFF")
        cell.fill = HEADER_FILL
        cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
        cell.border = BORDER
        if note:
            comment = Comment(note, "Kantin Sistemi")
            comment.width = 320
            comment.height = 110
            cell.comment = comment
        ws.column_dimensions[get_column_letter(idx)].width = width
    ws.row_dimensions[row].height = 38


def build_products(ws):
    style_header(ws, PRODUCT_COLUMNS)
    ws.freeze_panes = "A2"

    for r, values in enumerate(EXAMPLE_ROWS, start=2):
        for c, value in enumerate(values, start=1):
            cell = ws.cell(row=r, column=c, value=value)
            cell.fill = EXAMPLE_FILL

    for r in range(2, ROWS + 2):
        # HER IKI FIYAT DA KDV DAHIL. Alis KDV'si indirilmedigi icin
        # maliyettir; satisi netlestirip KDV dahil alisla karsilastirmak
        # KDV'yi IKI KEZ aleyhe saymak olurdu. Bkz. server/lib/money.js
        # Birim kar: satis - alis   [F=alis, G=satis, H=KDV]
        ws.cell(row=r, column=11).value = (
            f'=IF(OR($B{r}="",$F{r}="",$G{r}=""),"",ROUND($G{r}-$F{r},2))'
        )
        # Kar marji: birim kar / satis
        ws.cell(row=r, column=12).value = (
            f'=IF(OR($K{r}="",$G{r}=""),"",IF($G{r}=0,"",ROUND($K{r}/$G{r},4)))'
        )
        for c in range(1, 13):
            cell = ws.cell(row=r, column=c)
            cell.font = Font(name=FONT, size=10)
            cell.border = BORDER
            if c in (11, 12):
                cell.fill = CALC_FILL
            elif r > 1 + len(EXAMPLE_ROWS):
                cell.fill = INPUT_FILL
            if c in (6, 7, 10, 11):
                cell.number_format = "#,##0.00"
            elif c in (8, 9):
                cell.number_format = "#,##0"
            elif c == 12:
                cell.number_format = "0.0%"
            if c == 1:
                cell.number_format = "@"  # barkodu metin olarak tut, bilimsel gosterime dusmesin

    last = ROWS + 1
    add_list_validation(ws, CATEGORIES, f"C2:C{last}", "Kategori",
                        "Listeden seçin veya yeni bir kategori adı yazın.", allow_custom=True)
    add_list_validation(ws, UNITS, f"D2:D{last}", "Birim", "Listeden bir birim seçin.")
    add_list_validation(ws, PRODUCT_TYPES, f"E2:E{last}", "Ürün Tipi",
                        "Kantinde hazırlanan ürünler için 'Üretilen' seçin.")
    add_list_validation(ws, [str(v) for v in VAT_RATES], f"H2:H{last}", "KDV Oranı",
                        "Tedarikçi faturasındaki KDV oranı.", allow_custom=True)

    # Zarara satis ve dusuk marj uyarisi
    red = PatternFill("solid", fgColor="FFCDD2")
    amber = PatternFill("solid", fgColor="FFF3CD")
    ws.conditional_formatting.add(
        f"K2:L{last}", CellIsRule(operator="lessThan", formula=["0"], fill=red,
                                  font=Font(name=FONT, size=10, color="B71C1C", bold=True)))
    ws.conditional_formatting.add(
        f"L2:L{last}", CellIsRule(operator="between", formula=["0", "0.2"], fill=amber))


def add_list_validation(ws, values, ref, title, prompt, allow_custom=False):
    dv = DataValidation(
        type="list",
        formula1='"' + ",".join(values) + '"',
        allow_blank=True,
        showDropDown=False,          # False = acilir liste GORUNUR (OOXML tersine calisir)
        showErrorMessage=not allow_custom,
    )
    dv.promptTitle = title
    dv.prompt = prompt
    dv.showInputMessage = True
    dv.errorTitle = "Geçersiz değer"
    dv.error = "Lütfen listeden bir değer seçin."
    ws.add_data_validation(dv)
    dv.add(ref)


OPENING_COLUMNS = [
    ("Barkod", 16, "Ürün Listesi sekmesindeki barkod ile birebir aynı olmalıdır."),
    ("Ürün Adı", 34, "Barkodu olmayan ürünlerde eşleştirme ürün adına göre yapılır; "
                     "Ürün Listesi'ndeki adla birebir aynı yazın."),
    ("Kampüs Kodu", 16, "Listeden seçin."),
    ("Miktar", 14, "Sayım günü rafta + depoda bulunan toplam miktar."),
]


def build_opening(ws):
    style_header(ws, OPENING_COLUMNS)
    ws.freeze_panes = "A2"

    examples = [
        ["8690000000028", "Ayran 200 ml", "IKT", 48],
        ["8690000000011", "Su 500 ml", "IKT", 120],
        ["", "Tost", "ESN", 0],
    ]
    for r, values in enumerate(examples, start=2):
        for c, value in enumerate(values, start=1):
            cell = ws.cell(row=r, column=c, value=value)
            cell.fill = EXAMPLE_FILL

    for r in range(2, ROWS + 2):
        for c in range(1, 5):
            cell = ws.cell(row=r, column=c)
            cell.font = Font(name=FONT, size=10)
            cell.border = BORDER
            if r > 1 + len(examples):
                cell.fill = INPUT_FILL
            if c == 1:
                cell.number_format = "@"
            if c == 4:
                cell.number_format = "#,##0.00"

    add_list_validation(ws, [c[0] for c in CAMPUSES], f"C2:C{ROWS + 1}", "Kampüs Kodu",
                        "IKT / IST / ESN / KRC / CRL")


def build_instructions(ws):
    ws.sheet_view.showGridLines = False
    ws.column_dimensions["A"].width = 3
    ws.column_dimensions["B"].width = 30
    ws.column_dimensions["C"].width = 92

    def title(row, text):
        c = ws.cell(row=row, column=2, value=text)
        c.font = Font(name=FONT, size=13, bold=True, color=NAVY)
        ws.merge_cells(start_row=row, start_column=2, end_row=row, end_column=3)

    def line(row, label, text, bold=False):
        lc = ws.cell(row=row, column=2, value=label)
        lc.font = Font(name=FONT, size=10, bold=True)
        lc.alignment = Alignment(vertical="top")
        tc = ws.cell(row=row, column=3, value=text)
        tc.font = Font(name=FONT, size=10, bold=bold)
        tc.alignment = Alignment(vertical="top", wrap_text=True)
        ws.row_dimensions[row].height = max(16, 14 * (1 + len(text) // 95))

    ws.cell(row=1, column=2, value="TOPKAPI OKULLARI — KANTİN YÖNETİM SİSTEMİ").font = Font(
        name=FONT, size=16, bold=True, color=NAVY)
    ws.cell(row=2, column=2, value="Ürün Listesi ve Açılış Stoğu Şablonu").font = Font(
        name=FONT, size=11, color="64748B")

    r = 4
    title(r, "Nasıl doldurulur?")
    r += 1
    for label, text in [
        ("1. Ürün Listesi", "\"Ürün Listesi\" sekmesini doldurun. Sarı hücreler sizin doldurmanız içindir; "
                            "gri hücreler otomatik hesaplanır, onlara yazmayın."),
        ("2. Örnek satırlar", "İlk 3 satır yeşil renkli örnektir. Üzerine yazabilir veya satırları silebilirsiniz."),
        ("3. Zorunlu alanlar", "Başlığında * olan üç alan zorunludur: Ürün Adı, Alış Fiyatı, Satış Fiyatı."),
        ("4. Ürün tipi", "Tost, çay, poğaça gibi kantinde HAZIRLANAN ürünler için \"Üretilen\" seçin; "
                         "bunların içine giren ekmek, kaşar, çay gibi kalemler için \"Hammadde\" seçin. "
                         "Hammadde sayıma girer ama satılmaz (satış fiyatını 0 bırakın); tüketimi "
                         "uygulamadaki Reçeteler ekranından tanımlanır."),
        ("5. Açılış Stoğu", "İsteğe bağlıdır. Sisteme geçiş günü her kampüsteki mevcut miktarları girmek "
                            "isterseniz \"Açılış Stoğu\" sekmesini doldurun. Boş bırakırsanız stokları "
                            "uygulamadan da girebilirsiniz."),
        ("6. Yükleme", "Dosyayı kaydedin ve uygulamada Ürünler ekranındaki \"Excel'den Aktar\" düğmesiyle yükleyin. "
                       "Sistem yüklemeden önce size bir önizleme gösterir."),
    ]:
        line(r, label, text)
        r += 1

    r += 1
    title(r, "Fiyatlar — en sık yapılan hata")
    r += 1
    for label, text, bold in [
        ("Alış Fiyatı", "KDV DAHİL yazılır: faturada o kalem için fiilen ödediğiniz birim tutar "
                        "(genel toplam değil, tek bir adedin tutarı).", True),
        ("Satış Fiyatı", "KDV DAHİL yazılır. Öğrencinin kasada ödediği raf fiyatıdır.", True),
        ("Neden böyle?", "Ödediğiniz alış KDV'si beyannamede indirilmediği için gerçekten cebinizden "
                         "çıkıyor; yani bir maliyettir. Bu yüzden her iki fiyat da KDV DAHİL yazılır ve "
                         "kâr ikisinin farkıdır: kasanızda kalan gerçek tutar.", False),
        ("KDV oranı", "Tedarikçi faturanızda yazar. Süt, ekmek, taze meyve gibi temel gıdalarda düşük; "
                      "gazlı içecek, kırtasiye gibi ürünlerde yüksektir. Faturadan bakıp yazmanız yeterli.", False),
        ("Kontrol", "Doldururken sağdaki iki gri sütun anında birim kârı ve marjı gösterir. "
                    "Kırmızıya dönen satır zararına satış, sarı satır %20 altı marj demektir — "
                    "fiyatı veya KDV oranını kontrol edin.", False),
    ]:
        line(r, label, text, bold)
        r += 1

    r += 1
    title(r, "Kampüs kodları")
    r += 1
    for code, name in CAMPUSES:
        line(r, code, name)
        r += 1

    r += 1
    title(r, "İpuçları")
    r += 1
    for label, text in [
        ("Barkod", "Telefonla veya USB barkod okuyucuyla hücreye okutabilirsiniz. Barkod girilen ürünler "
                   "sayımda çok daha hızlı bulunur."),
        ("Barkodsuz ürün", "Tost, çay, poğaça gibi ürünlerde barkod boş kalabilir; sistem ada göre eşleştirir."),
        ("Aynı ürünü tekrar yükleme", "Barkodu daha önce yüklenmiş bir ürünü tekrar yüklerseniz sistem yeni "
                                      "kayıt açmaz, mevcut ürünü günceller. Fiyat güncellemesi için de "
                                      "bu şablonu kullanabilirsiniz."),
        ("Satır sayısı", "400 satır hazırdır. Daha fazlası gerekirse son satırı kopyalayıp aşağı çekin."),
        ("Kampüse özel fiyat", "Bir ürün bir kampüste farklı fiyata satılıyorsa, yükleme sonrası "
                               "uygulamadaki \"Kampüs Fiyatı\" düğmesinden ayarlayın."),
    ]:
        line(r, label, text)
        r += 1


def main():
    wb = Workbook()
    ws_info = wb.active
    ws_info.title = "Nasıl Doldurulur"
    build_instructions(ws_info)

    build_products(wb.create_sheet("Ürün Listesi"))
    build_opening(wb.create_sheet("Açılış Stoğu"))

    for out in OUTPUTS:
        out.parent.mkdir(parents=True, exist_ok=True)
        wb.save(out)
        print(f"Sablon olusturuldu: {out}")


if __name__ == "__main__":
    main()
