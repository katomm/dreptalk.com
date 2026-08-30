`noto-sans-jp-subset.ttf` is Noto Sans JP Bold (SIL Open Font License 1.1,
https://fonts.google.com/noto/specimen/Noto+Sans+JP) cut down to five glyphs
with `pyftsubset --text="忠実テスト"`. It stands in for what the OG card render
fetches from Google Fonts, so the fallback-font tests never touch the network.
