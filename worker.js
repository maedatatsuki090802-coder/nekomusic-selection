/**
 * NEKO MUSIC SELECT (⑦) 実データAPI + カタログ共有API
 *
 * 目的：nekomusics.com に実際に来た訪問者の「訪問・ページ閲覧・商品リンククリック・
 * 広告表示/クリック」を、ブラウザのlocalStorageだけでなくCloudflare KVにも記録し、
 * 運営ダッシュボード（⑥・admin.nekomusics.com）から後から取得できるようにする。
 * さらに follow-up（⑥↔⑦連携フェーズ1）で、⑦の商品カタログ（PRODUCTS）をKVに
 * 保管し、⑥からも同じデータを読めるようにする /api/catalog を追加した。
 *
 * エンドポイント：
 *   POST /api/track    … ⑦の各ページから、計測イベントを1件送る（同一オリジンなのでCORS不要）
 *   GET  /api/stats     … ⑥の管理画面から、集計済み「実訪問者データ」を取得する
 *                          （Bearerトークンで保護。トークンを知らない限り誰も読めない）
 *   GET  /api/catalog   … 商品カタログを取得する（認証なし・公開）。
 *                          ⑦自身のフロントエンド（nekomusics.com）が将来これを読んで
 *                          商品を表示する想定のエンドポイントなので、トークンをかけると
 *                          公開サイト自体が動かなくなってしまう。中身はnekomusics.com上に
 *                          今も普通に表示されている商品情報と同じであり、非公開情報は
 *                          含まれない。誰でもアクセスできてしまう点への対策としては、
 *                          ブラウザ経由のアクセス元をnekomusics.com/admin.nekomusics.comに
 *                          限定するCORS許可リストを設けている（下記ALLOWED_CATALOG_ORIGINS。
 *                          ただしCORSはブラウザ上のJSからのアクセスだけを制限する仕組みで
 *                          あり、curl等からの直接アクセス自体は止められない。これは
 *                          「公開情報を配る」エンドポイントである以上の限界であり、
 *                          本当に人を選んで公開したい情報はここには置かない）。
 *   PUT  /api/catalog   … （フェーズ2で追加予定・未実装）⑥からカタログを更新する。
 *                          ADMIN_TOKENで保護する。
 *
 * 設計方針：
 * - ⑥ admin.html 側の既存の集計・表示ロジック（renderCdplayerPage）は、
 *   「cdplayerDevices（deviceIdごとのオブジェクト）を横断集計する」という形を
 *   既にそのまま持っている。この形をそのまま流用できるよう、ここで保存・返却する
 *   集計オブジェクトの形（clicksByCategory / clicksByProduct / clicksBySource /
 *   adStats / totalClicks / visits / pageViews / productPageViews / visitLog /
 *   clickEvents）は、⑦側が今までadmin.htmlに送っていた「運営ダッシュボードへ
 *   反映する」チェックインペイロードと完全に同じ形にしてある。
 * - KVは単一キー（"cdp:agg"）に集計済みJSONを1つだけ持つシンプルな構成。
 *   複数の訪問者リクエストがミリ秒単位で衝突すると、KVの読み取り→書き込みの間に
 *   別のリクエストが割り込んで、片方の更新が失われる可能性がある（結果整合性の
 *   限界）。個人運営・小規模サイトの実績計測としては許容範囲という前提。
 *   将来、同時アクセスが増えて正確な計数がより重要になった場合は、D1
 *   （SQLデータベース）かDurable Objectsへの移行を検討する。
 * - カタログ（"cdp:catalog"）も同じKV namespace内の別キーに保存する単純な構成。
 *   初回アクセス時、KVにまだ何もなければ、select-cdplayer.html の PRODUCTS と
 *   完全に同じ内容（DEFAULT_CATALOG、下記）をKVへ書き込んでから返す。これにより
 *   ⑦の既存商品データを一切失うことなく、そのままKVへ引き継ぐ（フェーズ1の
 *   最優先事項：既存の⑦の機能・データを壊さない）。
 */

const VALID_TRACK_TYPES = ["visit", "pageview", "click", "ad_impression", "ad_click"];
const AGG_KEY = "cdp:agg";
const CATALOG_KEY = "cdp:catalog";
const EVENT_LOG_CAP = 300;

// follow-up（⑥↔⑦連携フェーズ1）: GET /api/catalog を、nekomusics.com / admin.nekomusics.com
// からのブラウザ経由アクセスのみに絞るための許可リスト。「apiにだれでもアクセスできるように
// しないでほしい」という指示への対応(前提と限界はファイル冒頭のコメント参照)。
const ALLOWED_CATALOG_ORIGINS = [
  "https://nekomusics.com",
  "https://admin.nekomusics.com"
];

// follow-up（⑥↔⑦連携フェーズ1）: select-cdplayer.html の `var PRODUCTS = {...}`
// （2026-09-21時点の内容）をそのまま複製したもの。KVがまだ空の場合の初期値・
// フォールバックとして使う。ここを書き換えても select-cdplayer.html 自体（⑦の
// 現在の表示）は一切変わらない（⑦はまだこのAPIを読みに行っていない＝フェーズ3で
// 切り替えるまでは今まで通り自分のPRODUCTSをそのまま使う）。
function defaultCatalog() {
  return {
    new_popularity: [
      { id:"pop-1", name:"Arafuna ポータブルCDプレーヤー（スピーカー内蔵・1400mAh充電式）", blurb:"スピーカー内蔵・USB充電式のコンパクトモデル。32GBまでのmicroSDカードにも対応し、Amazonでも定番の一台。", price:"¥6,420〜（通販サイト調べ・2026年9月時点）",
        img:"https://cache.ymall.jp/cabinet/F654/goods/L/F654-B08P6Q313X-20231011.jpg",
        links:{ amazon:"https://www.amazon.co.jp/Arafuna-CD5189B-CD%E3%83%97%E3%83%AC%E3%83%BC%E3%83%A4%E3%83%BC-%E3%83%9D%E3%83%BC%E3%82%BF%E3%83%96%E3%83%AB-brown/dp/B08H1QMTKM" } },
      { id:"pop-2", name:"VERSOS ポータブルCDプレーヤー VS-M015（ブラック）", blurb:"単3電池2本で駆動する軽量ボディの入門モデル。価格を抑えて手軽に始めたい人に選ばれている一台。", price:"¥4,378（通販サイト調べ・2026年9月時点）",
        img:"https://cdn.tower.jp/za/o/59/4582228228559.jpg",
        links:{ amazon:"https://www.amazon.co.jp/dp/B078ML8MN9" } },
      { id:"pop-3", name:"東芝 ポータブルCDプレーヤー TY-P50(W)", blurb:"価格.comのポータブルCDプレーヤー人気売れ筋ランキングで1位を獲得した、軽量250gの定番モデル。単3電池2本で約8時間再生できます。", price:"¥7,000〜（価格.com調べ・2026年9月時点）",
        img:"https://shop.r10s.jp/superdeal/cabinet/09061004/09846908/4560158875982.jpg",
        links:{ amazon:"https://www.amazon.co.jp/dp/B0BW8ZM1F8", rakuten:"https://hb.afl.rakuten.co.jp/ichiba/574ec36b.adfc0fdd.574ec36c.923807e5/?pc=https%3A%2F%2Fitem.rakuten.co.jp%2Fsuperdeal%2F12563cdtyp502304%2F" } },
      { id:"pop-4", name:"東芝 ポータブルCDプレーヤー TY-P20(W)", blurb:"リモコン付きでステレオスピーカーを搭載した、東芝の定番モデル。大手メーカーならではの安心感。", price:"¥6,351（価格.com調べ・2026年9月時点）",
        img:"https://r.r10s.jp/g/gran_img/ko/PEO/A56/RY0/A41/0b3acac3f042308ce50b26a6be7c12a4.jpg",
        links:{ amazon:"https://www.amazon.co.jp/dp/B0B31GJD2R" } },
      { id:"pop-5", name:"FIIO DM13 BT（トランスペアレント）", blurb:"CD音源をUSB経由でリッピングできるBluetooth対応モデル。透明ボディが目を引く、軽量で持ち運びやすい一台。", price:"参考¥28,622〜（税別・EDION調べ・2026年9月時点）",
        img:"https://www.edion.com/ito/product/9995/04562314019995/300x300/4562314019995_1.jpg",
        links:{ amazon:"https://www.amazon.co.jp/dp/B0DVGNNCVN", rakuten:"https://hb.afl.rakuten.co.jp/ichiba/574ec36b.adfc0fdd.574ec36c.923807e5/?pc=https%3A%2F%2Fitem.rakuten.co.jp%2Fe-earphone%2F4562314019995%2F" } }
    ],
    new_quality: [
      { id:"qual-1", name:"FIIO DM15 R2R（ホワイト）", blurb:"R2R方式のDACを搭載した上位モデル。持ち運べるサイズで本格的な音を求める人へ。", price:"¥48,844（楽天市場調べ・2026年9月時点）",
        img:"https://shop.r10s.jp/mikidj/cabinet/audio/4562314021400.jpg",
        links:{ amazon:"https://www.amazon.co.jp/dp/B0GKG3FRGQ", rakuten:"https://hb.afl.rakuten.co.jp/ichiba/574ec36b.adfc0fdd.574ec36c.923807e5/?pc=https%3A%2F%2Fitem.rakuten.co.jp%2Fmikidj%2F4562314021400%2F" } },
      { id:"qual-2", name:"FIIO DM13 BT（ブラック）", blurb:"Bluetooth出力にも対応するCDプレーヤー。CD音源をUSB経由でリッピングできる機能も搭載し、音質にこだわりたい人向けの一台。", price:"¥26,322（楽天市場調べ・2026年9月時点）",
        img:"https://shop.r10s.jp/e-earphone/cabinet/fiio/imgrc0101561294.jpg",
        links:{ amazon:"https://www.amazon.co.jp/dp/B09WXSXWKF", rakuten:"https://hb.afl.rakuten.co.jp/ichiba/574ec36b.adfc0fdd.574ec36c.923807e5/?pc=https%3A%2F%2Fitem.rakuten.co.jp%2Fe-earphone%2F4562314019964%2F" } },
      { id:"qual-3", name:"RELAX PIXEL TUNES CDプレーヤー", blurb:"スケルトンデザインが目を引く、Bluetooth5.3対応のこだわりモデル。バッテリー駆動で持ち運びも可能。", price:"¥12,980（楽天市場調べ・2026年9月時点）",
        img:"https://shop.r10s.jp/flgds/cabinet/since/pxltns-thum26.jpg",
        links:{ amazon:"https://www.amazon.co.jp/dp/B0F3HXRNVP", rakuten:"https://hb.afl.rakuten.co.jp/ichiba/574ec36b.adfc0fdd.574ec36c.923807e5/?pc=https%3A%2F%2Fitem.rakuten.co.jp%2Fflgds%2Fpixeltunes%2F" } },
      { id:"qual-4", name:"東芝 ポータブルCDプレーヤー TY-P50", blurb:"大手メーカーならではの安心感。操作がシンプルで扱いやすい一台。", price:"¥7,980（楽天市場調べ・2026年9月時点）",
        img:"https://shop.r10s.jp/superdeal/cabinet/09061004/09846908/4560158875982.jpg",
        links:{ amazon:"https://www.amazon.co.jp/s?k=%E6%9D%B1%E8%8A%9D%20%E3%83%9D%E3%83%BC%E3%82%BF%E3%83%96%E3%83%ABCD%E3%83%97%E3%83%AC%E3%83%BC%E3%83%A4%E3%83%BC%20TY-P50", rakuten:"https://hb.afl.rakuten.co.jp/ichiba/574ec36b.adfc0fdd.574ec36c.923807e5/?pc=https%3A%2F%2Fitem.rakuten.co.jp%2Fsuperdeal%2F12563cdtyp502304%2F" } },
      { id:"qual-5", name:"東芝 ポータブルCDプレーヤー TY-P2", blurb:"単3電池2本で駆動するシンプル設計。スピーカー内蔵でヘッドホンなしでも再生できる、ロングセラーモデル。", price:"¥8,841（価格.com調べ・2026年9月時点）",
        img:"https://image.yodobashi.com/product/100/000/001/004/046/474/100000001004046474_10201.jpg",
        links:{ amazon:"https://www.amazon.co.jp/dp/B07H6L79Q2" } }
    ],
    new_price: [
      { id:"price-1", name:"VERSOS ポータブルCDプレーヤー VS-PCD01BB", blurb:"乾電池とACアダプターの2電源に対応。価格を最優先したい人向けの一台。", price:"¥3,390（価格.com調べ・2026年9月時点）",
        img:"https://shop.r10s.jp/nanahachi/cabinet/ec01/ec11/vs-pcd01.jpg",
        links:{ amazon:"https://www.amazon.co.jp/dp/B09QKT916Q", rakuten:"https://hb.afl.rakuten.co.jp/ichiba/574ec36b.adfc0fdd.574ec36c.923807e5/?pc=https%3A%2F%2Fitem.rakuten.co.jp%2Fnanahachi%2Fvs-pcd01%2F" } },
      { id:"price-2", name:"オーム電機 AudioComm CDP-510N（語学学習用）", blurb:"英語学習・リスニング対策向けに再生速度を調整できるモデル。乾電池で手軽に使える。", price:"¥4,293（価格.com調べ・2026年9月時点）",
        img:"https://shop.r10s.jp/e-price/cabinet/item25/03723510.jpg",
        links:{ amazon:"https://www.amazon.co.jp/dp/B0BZ7PN15G", rakuten:"https://hb.afl.rakuten.co.jp/ichiba/574ec36b.adfc0fdd.574ec36c.923807e5/?pc=https%3A%2F%2Fitem.rakuten.co.jp%2Fe-price%2F03-7235%2F" } },
      { id:"price-3", name:"WINTECH ポータブルCDプレーヤー PCD-32", blurb:"音飛び防止機能・プログラム再生に対応したシンプルなモデル。ステレオイヤホン付き。", price:"¥4,499（価格.com調べ・2026年9月時点）",
        img:"https://shop.r10s.jp/yuasa-p-n/cabinet/s_img30/4521171116438.jpg",
        links:{ amazon:"https://www.amazon.co.jp/dp/B081H2QCBX", rakuten:"https://hb.afl.rakuten.co.jp/ichiba/574ec36b.adfc0fdd.574ec36c.923807e5/?pc=https%3A%2F%2Fitem.rakuten.co.jp%2Fyuasa-p-n%2F4521171116438%2F" } },
      { id:"price-4", name:"オーム電機 AudioComm CDP-560N（Bluetooth機能付き）", blurb:"Bluetooth送信にも対応した語学学習向けモデル。速度調整で英語学習にも使いやすい。", price:"¥5,121（価格.com調べ・2026年9月時点）",
        img:"https://shop.r10s.jp/e-price/cabinet/item25/03725510.jpg",
        links:{ amazon:"https://www.amazon.co.jp/dp/B0BZ7PSRTP", rakuten:"https://hb.afl.rakuten.co.jp/ichiba/574ec36b.adfc0fdd.574ec36c.923807e5/?pc=https%3A%2F%2Fitem.rakuten.co.jp%2Fe-price%2F03-7255%2F" } },
      { id:"price-5", name:"オーム電機 AudioComm CDP-520N（スピーカー内蔵）", blurb:"スピーカー内蔵でヘッドホンなしでも再生可能。USB給電・乾電池の2電源対応。", price:"¥5,229（価格.com調べ・2026年9月時点）",
        img:"https://shop.r10s.jp/e-price/cabinet/item26/03727010.jpg",
        links:{ amazon:"https://www.amazon.co.jp/dp/B0C7TC93M1", rakuten:"https://hb.afl.rakuten.co.jp/ichiba/574ec36b.adfc0fdd.574ec36c.923807e5/?pc=https%3A%2F%2Fitem.rakuten.co.jp%2Fe-price%2F03-7270%2F" } }
    ],
    new_home: [
      { id:"nh-1", name:"東芝 高音質CDラジオ TY-ANC1", blurb:"CDラジオながら音質を意識した設計の一台。まず気軽に部屋に置きたい人へ。", price:"¥10,480（楽天市場調べ・2026年9月時点）",
        img:"https://shop.r10s.jp/yutori/cabinet/ittukatu7/ty-anc1-1.jpg",
        links:{ rakuten:"https://hb.afl.rakuten.co.jp/ichiba/574ec36b.adfc0fdd.574ec36c.923807e5/?pc=https%3A%2F%2Fitem.rakuten.co.jp%2Fyutori%2Fty-anc1%2F", amazon:"https://www.amazon.co.jp/s?k=%E6%9D%B1%E8%8A%9D%20%E9%AB%98%E9%9F%B3%E8%B3%AACD%E3%83%A9%E3%82%B8%E3%82%AA%20TY-ANC1" } },
      { id:"nh-2", name:"東芝 CDラジオ TY-C250(W)", blurb:"CD・ラジオ・カセットに対応した3ウェイ仕様。価格を抑えて部屋に置きたい人への定番モデル。", price:"¥10,720（楽天市場調べ・2026年9月時点）",
        img:"https://r.r10s.jp/g/gran_img/ho/PEE/OEV/5V8/8IZ/c0b714f69bba08d9cde017f5ac82ce78.jpg",
        links:{ amazon:"https://www.amazon.co.jp/dp/B01MYC7GUA" } },
      { id:"nh-3", name:"Panasonic CDラジオ RX-D47-S", blurb:"CD・ラジオ・カセットを1台にまとめたシルバーボディ。取っ手付きで部屋の中でも移動させやすい一台。", price:"¥21,356（価格.com調べ・2026年9月時点）",
        img:"https://r.r10s.jp/g/gran_img/ho/PEE/3SL/VYN/3MB/f12231f640ea123cedd0d65a4e27f164.jpg",
        links:{ amazon:"https://www.amazon.co.jp/dp/B01GJB7VMS" } },
      { id:"nh-4", name:"Panasonic CDラジオ RX-D70BT-K", blurb:"Bluetooth再生にも対応した上位モデル。落ち着いたブラックで、本格的に部屋で聴きたい人へ。", price:"¥29,784（価格.com調べ・2026年9月時点）",
        img:"https://r.r10s.jp/g/gran_img/im/PED/179/MBZ/DBR/53561e983a4a95c223965c8e13bd8519.jpg",
        links:{ amazon:"https://www.amazon.co.jp/dp/B07Q1L61BX" } },
      { id:"nh-5", name:"SONY CDラジオカセットレコーダー CFD-S401", blurb:"CD・ラジオ・カセットに対応したロングセラーモデル。乾電池でも使えるので停電時にも安心。", price:"¥27,880（価格.com調べ・2026年9月時点）",
        img:"https://img1.kakaku.k-img.com/images/productimage/fullscale/K0000965643.jpg",
        links:{ amazon:"https://www.amazon.co.jp/dp/B07KNTD3KD" } }
    ],
    used_portable: [
      { id:"up-1", name:"オーム電機 AudioComm CDP-828Z（中古）", blurb:"生産終了済みのシンプルなポータブル機。価格を抑えて掘り出し物を探したい人へ。", price:"¥3,990（中古・楽天市場調べ・2026年9月時点）",
        img:"https://shop.r10s.jp/wonderrex/cabinet/6457/260527/6458/19786-1.jpg",
        links:{ mercari:"https://jp.mercari.com/search?keyword=%E3%82%AA%E3%83%BC%E3%83%A0%E9%9B%BB%E6%A9%9F%20AudioComm%20CDP-828Z&afid=2335847088" } },
      { id:"up-2", name:"東芝 ポータブルCD TY-P20（中古）", blurb:"ラジオ・USB・カセットにも対応した往年のモデル。", price:"¥5,060（中古・楽天市場調べ・2026年9月時点）",
        img:"https://shop.r10s.jp/jumblestore/cabinet/57040/2330014757040-01.jpg",
        links:{ mercari:"https://jp.mercari.com/search?keyword=%E6%9D%B1%E8%8A%9D%20%E3%83%9D%E3%83%BC%E3%82%BF%E3%83%96%E3%83%ABCD%20TY-P20&afid=2335847088" } },
      { id:"up-3", name:"AIWA ポータブルCDプレーヤー XP-A20（中古）", blurb:"今はもう手に入らないブランドの一台。レトロな一台との出会いを探したい人へ。", price:"¥6,980（中古・楽天市場調べ・2026年9月時点）",
        img:"https://shop.r10s.jp/raremon/cabinet/premiere/887987987987.jpg",
        links:{ mercari:"https://jp.mercari.com/search?keyword=AIWA%20%E3%83%9D%E3%83%BC%E3%82%BF%E3%83%96%E3%83%ABCD%E3%83%97%E3%83%AC%E3%83%BC%E3%83%A4%E3%83%BC%20XP-A20&afid=2335847088" } },
      { id:"up-4", name:"SONY CDウォークマン D-NE730（中古）", blurb:"MP3再生にも対応したポータブルCDウォークマン。リモコン・イヤホン付きで状態の良い出品を発見。", price:"¥8,888（メルカリ出品・2026年9月時点）",
        img:"https://www.sony.jp/products/picture/D-NE730.jpg",
        links:{ mercari:"https://jp.mercari.com/item/m10746843871?afid=2335847088" } },
      { id:"up-5", name:"SONY CDウォークマン D-EJ100（中古）", blurb:"「Psyc」の愛称で親しまれた歴代モデル。CDウォークマンはやっぱりSONY、という人に選んでほしい一台。", price:"中古相場は要確認（メルカリで検索）",
        img:"https://retrospekt.com/cdn/shop/files/PD-VR-1095_1.jpg?v=1722281042",
        links:{ mercari:"https://jp.mercari.com/search?keyword=SONY%20CD%E3%82%A6%E3%82%A9%E3%83%BC%E3%82%AF%E3%83%9E%E3%83%B3%20D-EJ100&afid=2335847088" } }
    ],
    used_home: [
      { id:"uh-1", name:"YAMAHA CD-S303（中古）", blurb:"生産終了済みの往年の定番モデル。中古・掘り出し物として今も探されている一台。", price:"¥26,378（中古・楽天市場調べ・2026年9月時点）",
        img:"https://shop.r10s.jp/wattmann/cabinet/item20260822/9368020156512-1.jpg",
        links:{ mercari:"https://jp.mercari.com/search?keyword=YAMAHA%20CD-S303&afid=2335847088" } },
      { id:"uh-2", name:"SONY CDP-X77ES（中古）", blurb:"往年の名機として今も語られる、SONYのハイエンドCDプレーヤー。本格的な一台に出会いたい人へ。", price:"¥79,900（中古・楽天市場調べ・2026年9月時点）",
        img:"https://shop.r10s.jp/wonderrex/cabinet/6457/250530/6475/52409-1.jpg",
        links:{ mercari:"https://jp.mercari.com/search?keyword=SONY%20CDP-X77ES&afid=2335847088" } },
      { id:"uh-3", name:"Panasonic CDシステム SC-HC300（中古）", blurb:"Bluetooth対応のCDシステム。スピーカー一体型で手軽に部屋で聴ける。", price:"¥7,990（中古・楽天市場調べ・2026年9月時点）",
        img:"https://shop.r10s.jp/wonderrex/cabinet/6457/250218/6458/04613-1.jpg",
        links:{ mercari:"https://jp.mercari.com/search?keyword=Panasonic%20CD%E3%82%B7%E3%82%B9%E3%83%86%E3%83%A0%20SC-HC300&afid=2335847088" } },
      { id:"uh-4", name:"TOoKA BASE CDプレーヤー TKB-001（中古）", blurb:"あまり知られていないブランドの一台。掘り出し物との出会いを楽しみたい人へ。", price:"¥7,990（中古・楽天市場調べ・2026年9月時点）",
        img:"https://shop.r10s.jp/wonderrex/cabinet/6457/250329/6458/23478-1.jpg",
        links:{ mercari:"https://jp.mercari.com/search?keyword=TOoKA%20BASE%20CD%E3%83%97%E3%83%AC%E3%83%BC%E3%83%A4%E3%83%BC&afid=2335847088" } },
      { id:"uh-5", name:"Panasonic CDシステム SC-HC28（中古）", blurb:"SC-HC300の一世代前のモデル。手頃な価格で手に入る一台。", price:"¥5,990（中古・楽天市場調べ・2026年9月時点）",
        img:"https://shop.r10s.jp/wonderrex/cabinet/6457/250525/6458/49300-1.jpg",
        links:{ mercari:"https://jp.mercari.com/search?keyword=Panasonic%20CD%E3%82%B7%E3%82%B9%E3%83%86%E3%83%A0%20SC-HC28&afid=2335847088" } }
    ],
    used_y2k: [
      { id:"y2k-1", name:"SONY CDウォークマン D-EJ011（2000年代前半・中古）", blurb:"「CDウォークマン」の代名詞的存在。ソニーは携帯オーディオで長年国内トップシェアを守り続けたブランドで、当時の学生の多くが実際に使っていたのはこのシリーズでした。", price:"中古相場は要確認（メルカリで検索）",
        img:"https://retrospekt.com/cdn/shop/files/PD-VR-1022_1.jpg",
        links:{ mercari:"https://jp.mercari.com/search?keyword=SONY%20CD%E3%82%A6%E3%82%A9%E3%83%BC%E3%82%AF%E3%83%9E%E3%83%B3%20D-EJ011&afid=2335847088" } },
      { id:"y2k-2", name:"Panasonic SL-CT490（2002年・中古）", blurb:"厚さ約23.3mmの薄型ボディに48秒耐振メモリーを搭載した、2000年代を代表する一台。", price:"¥10,980（中古・楽天市場調べ・2026年9月時点）",
        img:"https://shop.r10s.jp/snetshop/cabinet/3026/d0513026.jpg",
        links:{ mercari:"https://jp.mercari.com/search?keyword=Panasonic%20SL-CT490&afid=2335847088" } },
      { id:"y2k-3", name:"aiwa XP-V310（2000年・中古）", blurb:"当時アイワはヘッドホンステレオ市場で高いシェアを持ち、手頃な価格で学生にも選ばれていたブランド。スケルトンカラーが人気だった一台。", price:"中古相場は要確認（メルカリで検索）",
        img:"https://blogger.googleusercontent.com/img/b/R29vZ2xl/AVvXsEgs5YGb7j6q3rTn7sE9HdR33v4ohE1VXI_gz_ijU-MqYq0g9cnbqafWs9lrJkyldXG0viwRsrINQUvGHfMfyoLcZRgL-SBoxsCikkkUawMDOBGnGKNjqg63qpR_9ytQJ8xUGqhpizMT8vyd/s1600/2011_10_20_142516.JPG",
        links:{ mercari:"https://jp.mercari.com/search?keyword=aiwa%20XP-V310&afid=2335847088" } },
      { id:"y2k-4", name:"KENWOOD DPC-X517（2000年・中古）", blurb:"3色展開のファッショナブルなデザインが特徴。当時の読者投票でポータブルCD部門4位を獲得した一台。", price:"中古相場は要確認（メルカリで検索）",
        img:"https://blogger.googleusercontent.com/img/b/R29vZ2xl/AVvXsEjuKBqBinvh26FaUw1e0nUpYDXDAc13Oi2PVEIn3xzz9K0plDFNclZ447Efbdw3g6wG8Mci6M2MaCH3yMnKs_3qTWpm_xWBVdAZ0C20BPvtr-KnZq0FGj3Ldkj8w28jNFE4Cah7jjuJIQw/s1600/DSC_0202.JPG",
        links:{ mercari:"https://jp.mercari.com/search?keyword=KENWOOD%20DPC-X517&afid=2335847088" } },
      { id:"y2k-5", name:"Pioneer PCD-025 LOOPMASTER（1999年・中古）", blurb:"10〜20代をターゲットに、透明ボディの11色展開で発売されたLOOPMASTERシリーズの一台。発売時は月産2万台規模で展開されていました。", price:"中古相場は要確認（メルカリで検索）",
        img:"https://jpn.pioneer/ja/corp/news/press/images/pcd-025.gif",
        links:{ mercari:"https://jp.mercari.com/search?keyword=Pioneer%20PCD-025&afid=2335847088" } }
    ],
    new_recommend: [
      { id:"rec-1", name:"SONY CDウォークマン D-NE241（ブラック）", blurb:"CDウォークマンの系譜を継ぐ、シンプルなブラックボディ。ロマンを語るなら、まずはこの一台から。", price:"生産終了・価格はAmazonの商品ページでご確認ください",
        img:"https://www.sony.jp/products/picture/D-NE241.jpg",
        links:{ amazon:"https://www.amazon.co.jp/SONY-CD%E3%82%A6%E3%82%A9%E3%83%BC%E3%82%AF%E3%83%9E%E3%83%B3-N241-%E3%83%96%E3%83%A9%E3%83%83%E3%82%AF-D-NE241/dp/B004BC7CXG" } },
      { id:"rec-2", name:"Gueray ポータブルCDプレーヤー H01（スピーカーなし・ブラック）", blurb:"ESP音飛び防止・Type-C給電に対応した小型モデル。スピーカーを持たない、聴くことに徹した設計。", price:"価格はAmazonの商品ページでご確認ください",
        img:"https://gueray.com/cdn/shop/files/gueray-h01-portable-cd-player-8448502.jpg?v=1781809750&width=1400",
        links:{ amazon:"https://www.amazon.co.jp/dp/B0G2WCRSKW" } },
      { id:"rec-3", name:"東芝 ポータブルCDプレーヤー AX-CP50-W", blurb:"ワイヤレスBluetoothと有線イヤホンの両対応。コンパクトなボディに詰め込まれた東芝らしい手堅さ。", price:"¥9,840（ヨドバシ調べ・2026年9月時点）",
        img:"https://image.yodobashi.com/product/100/000/001/009/541/345/100000001009541345_10201.jpg",
        links:{ amazon:"https://www.amazon.co.jp/dp/B0GVWJ8B8D", rakuten:"https://hb.afl.rakuten.co.jp/ichiba/574ec36b.adfc0fdd.574ec36c.923807e5/?pc=https%3A%2F%2Fitem.rakuten.co.jp%2Fyamada-denki%2F4222775012%2F" } },
      { id:"rec-4", name:"ロジテック ポータブルCDプレーヤー LCP-PAPB02WH（ホワイト）", blurb:"リモコン付きで有線・Bluetooth両対応。真っ白なボディが、部屋にもカバンにも馴染む一台。", price:"参考¥6,578〜（価格.com調べ・2026年9月時点）",
        img:"https://shop.r10s.jp/edion/cabinet/goods/ll/img_268/4580333608075_ll.jpg",
        links:{ amazon:"https://www.amazon.co.jp/dp/B0B96YKG3B", rakuten:"https://hb.afl.rakuten.co.jp/ichiba/574ec36b.adfc0fdd.574ec36c.923807e5/?pc=https%3A%2F%2Fitem.rakuten.co.jp%2Fedion%2F4580333608075%2F" } },
      { id:"rec-5", name:"ミニコンポ WTB-797（レトロスタイル）", blurb:"Bluetooth・FMステレオ・USB再生にも対応した、ビンテージ調のワンボディコンポ。部屋に置いて眺めたくなる一台。", price:"¥16,408（楽天市場調べ・2026年9月時点）",
        img:"https://shop.r10s.jp/ppp-shop/cabinet/aaapic/systempic023/10cthlslw71.jpg",
        links:{ amazon:"https://www.amazon.co.jp/dp/B0CTHLSLW7", rakuten:"https://hb.afl.rakuten.co.jp/ichiba/574ec36b.adfc0fdd.574ec36c.923807e5/?pc=https%3A%2F%2Fitem.rakuten.co.jp%2Fppp-shop%2F10cthlslw7%2F" } },
      { id:"rec-6", name:"km5 CDプレーヤー Instant Disk Audio CP1（ホワイト・壁掛け対応）", blurb:"壁に掛けても、棚に置いても様になるBluetooth対応モデル。ランキングの外側にある、もうひとつの正解。", price:"¥19,800（価格.com調べ・2026年9月時点）",
        img:"https://km5.co.jp/cdn/shop/files/km5_Website_ShopP_1500x1500_Cp1_White.png?v=1775015272",
        links:{ amazon:"https://www.amazon.co.jp/dp/B0C1J6LDJ6", rakuten:"https://hb.afl.rakuten.co.jp/ichiba/574ec36b.adfc0fdd.574ec36c.923807e5/?pc=https%3A%2F%2Fitem.rakuten.co.jp%2Fftk-tsutayaelectrics%2Fmmus4595641086026%2F" } }
    ]
  };
}

function defaultAgg() {
  return {
    clicksByCategory: {},
    clicksByProduct: {},
    clicksBySource: {},
    adStats: {},
    totalClicks: 0,
    firstClickAt: null,
    lastClickAt: null,
    visits: 0,
    pageViews: 0,
    productPageViews: 0,
    firstVisitAt: null,
    lastVisitAt: null,
    visitLog: [],
    clickEvents: []
  };
}

function pushCapped(arr, item, cap) {
  arr.push(item);
  if (arr.length > cap) arr.splice(0, arr.length - cap);
}

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

// 既存の /api/stats 用（変更なし）：呼び出し元のOriginをそのまま許可する。
// /api/stats はADMIN_TOKENで保護されているため、これ自体が実質的なアクセス制御になっている。
function withCors(resp, origin) {
  const headers = new Headers(resp.headers);
  headers.set("access-control-allow-origin", origin || "*");
  headers.set("access-control-allow-methods", "GET, OPTIONS");
  headers.set("access-control-allow-headers", "authorization, content-type");
  headers.set("access-control-max-age", "86400");
  return new Response(resp.body, { status: resp.status, headers });
}

// follow-up（⑥↔⑦連携フェーズ1）: /api/catalog 専用。認証トークンをかけられない
// （公開サイト自身が読みに行くエンドポイントのため）代わりに、許可リストに
// 載っているOriginだけにブラウザ経由アクセスを絞る。リストに無いOriginからの
// アクセスにはCORSヘッダーを付けない＝ブラウザ上のJSからは読めなくなる
// （直接のURLアクセスやcurl等は元々CORSの対象外で止められない）。
function withRestrictedCors(resp, origin) {
  const headers = new Headers(resp.headers);
  if (origin && ALLOWED_CATALOG_ORIGINS.indexOf(origin) !== -1) {
    headers.set("access-control-allow-origin", origin);
  }
  headers.set("access-control-allow-methods", "GET, OPTIONS");
  headers.set("access-control-allow-headers", "authorization, content-type");
  headers.set("access-control-max-age", "86400");
  return new Response(resp.body, { status: resp.status, headers });
}

async function handleTrack(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ ok: false, error: "invalid_json" }, 400);
  }
  const type = body && body.type;
  if (VALID_TRACK_TYPES.indexOf(type) === -1) {
    return json({ ok: false, error: "invalid_type" }, 400);
  }

  let agg;
  try {
    agg = await env.CDP_STATS.get(AGG_KEY, { type: "json" });
  } catch (e) {
    agg = null;
  }
  if (!agg) agg = defaultAgg();

  const now = Date.now();

  if (type === "visit") {
    agg.visits = (agg.visits || 0) + 1;
    agg.firstVisitAt = agg.firstVisitAt || now;
    agg.lastVisitAt = now;
    pushCapped(agg.visitLog, { type: "visit", ts: now }, EVENT_LOG_CAP);
  } else if (type === "pageview") {
    agg.pageViews = (agg.pageViews || 0) + 1;
    const isProductView = !!body.productView;
    if (isProductView) agg.productPageViews = (agg.productPageViews || 0) + 1;
    pushCapped(agg.visitLog, { type: isProductView ? "productView" : "pageview", ts: now }, EVENT_LOG_CAP);
  } else if (type === "click") {
    const category = String(body.category || "");
    const productId = String(body.productId || "");
    const productName = String(body.productName || "");
    const rank = Number(body.rank) || 0;
    const source = String(body.source || "");
    if (!category || !productId || !source) return json({ ok: false, error: "missing_fields" }, 400);
    agg.totalClicks = (agg.totalClicks || 0) + 1;
    agg.firstClickAt = agg.firstClickAt || now;
    agg.lastClickAt = now;
    agg.clicksByCategory[category] = (agg.clicksByCategory[category] || 0) + 1;
    if (!agg.clicksByProduct[productId]) agg.clicksByProduct[productId] = { name: productName, count: 0 };
    agg.clicksByProduct[productId].name = productName || agg.clicksByProduct[productId].name;
    agg.clicksByProduct[productId].count = (agg.clicksByProduct[productId].count || 0) + 1;
    agg.clicksBySource[source] = (agg.clicksBySource[source] || 0) + 1;
    pushCapped(agg.clickEvents, { category, productId, productName, rank, source, ts: now }, EVENT_LOG_CAP);
  } else if (type === "ad_impression" || type === "ad_click") {
    const adId = String(body.adId || "");
    if (!adId) return json({ ok: false, error: "missing_fields" }, 400);
    if (!agg.adStats[adId]) agg.adStats[adId] = { impressions: 0, clicks: 0 };
    if (type === "ad_impression") agg.adStats[adId].impressions = (agg.adStats[adId].impressions || 0) + 1;
    else agg.adStats[adId].clicks = (agg.adStats[adId].clicks || 0) + 1;
  }

  try {
    await env.CDP_STATS.put(AGG_KEY, JSON.stringify(agg));
  } catch (e) {
    return json({ ok: false, error: "kv_write_failed" }, 500);
  }
  return json({ ok: true });
}

async function handleStats(request, env, origin) {
  const authHeader = request.headers.get("authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!env.ADMIN_TOKEN || !token || token !== env.ADMIN_TOKEN) {
    return withCors(json({ ok: false, error: "unauthorized" }, 401), origin);
  }
  let agg;
  try {
    agg = await env.CDP_STATS.get(AGG_KEY, { type: "json" });
  } catch (e) {
    agg = null;
  }
  if (!agg) agg = defaultAgg();
  return withCors(json({ ok: true, data: agg, fetchedAt: Date.now() }), origin);
}

// follow-up（⑥↔⑦連携フェーズ1）: GET /api/catalog。認証なし・公開。
// KVに "cdp:catalog" が無ければ、defaultCatalog()（⑦の現在の実データと同一）で
// 初期化してから返す。既存のPRODUCTSデータを失わないための一回限りの引き継ぎ。
async function handleCatalogGet(request, env, origin) {
  let catalog;
  try {
    catalog = await env.CDP_STATS.get(CATALOG_KEY, { type: "json" });
  } catch (e) {
    catalog = null;
  }
  if (!catalog) {
    catalog = defaultCatalog();
    try {
      await env.CDP_STATS.put(CATALOG_KEY, JSON.stringify(catalog));
    } catch (e) {
      // KVへの初期化書き込みに失敗しても、レスポンス自体はdefaultCatalog()で返す
      // （次回アクセス時に改めて初期化を試みる）。
    }
  }
  return withRestrictedCors(json({ ok: true, data: catalog, fetchedAt: Date.now() }), origin);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("origin") || "*";

    if (url.pathname === "/api/track") {
      if (request.method === "OPTIONS") return withCors(json({ ok: true }), origin);
      if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
      return handleTrack(request, env);
    }

    if (url.pathname === "/api/stats") {
      if (request.method === "OPTIONS") return withCors(json({ ok: true }), origin);
      if (request.method !== "GET") return withCors(json({ ok: false, error: "method_not_allowed" }, 405), origin);
      return handleStats(request, env, origin);
    }

    if (url.pathname === "/api/catalog") {
      if (request.method === "OPTIONS") return withRestrictedCors(json({ ok: true }), origin);
      if (request.method !== "GET") return withRestrictedCors(json({ ok: false, error: "method_not_allowed" }, 405), origin);
      return handleCatalogGet(request, env, origin);
      // PUT /api/catalog（ADMIN_TOKEN保護・⑥からの書き込み）はフェーズ2で追加予定。未実装。
    }

    // API以外は今まで通り静的ファイル（index.htmlのSPAフォールバック含む）をそのまま配信する。
    return env.ASSETS.fetch(request);
  }
};
