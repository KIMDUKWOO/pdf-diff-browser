import * as pdfjsLib from "pdfjs-dist";
import { PDFDocument, rgb } from "pdf-lib";
import { diffWords } from "diff";

// pdf.js worker (Vite용)
import pdfWorker from "pdfjs-dist/build/pdf.worker?url";
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

/* -------------------- 유틸 -------------------- */
const $ = (id) => document.getElementById(id);

const log = (msg) => {
  const el = $("log");
  el.textContent += (el.textContent ? "\n" : "") + msg;
};

const setStatus = (msg, p = null) => {
  $("status").textContent = msg ?? "";
  if (p !== null) $("prog").value = p;
};

// File → Uint8Array
async function fileToUint8Array(file) {
  return new Uint8Array(await file.arrayBuffer());
}

/* -------------------- PDF.js: 텍스트 + 좌표 추출 -------------------- */
async function extractWordsWithPositions(data, label) {
  const loadingTask = pdfjsLib.getDocument({ data });
  const pdf = await loadingTask.promise;

  const pages = [];

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    setStatus(`${label}: 텍스트 추출 중 (${pageNum}/${pdf.numPages})`, Math.round((pageNum / pdf.numPages) * 40));

    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1 });

    const content = await page.getTextContent();
    const words = [];

    for (const item of content.items) {
      const text = (item.str || "").trim();
      if (!text) continue;

      const [a, b, c, d, e, f] = item.transform;
      const fontHeight = item.height || Math.abs(d) || 10;
      const parts = text.split(/\s+/).filter(Boolean);
      const wordWidth = item.width && parts.length ? item.width / parts.length : item.width || 8;

      for (let i = 0; i < parts.length; i++) {
        words.push({
          text: parts[i],
          x: e + i * wordWidth,
          y: f,
          width: wordWidth,
          height: fontHeight,
        });
      }
    }

    pages.push({
      pageNum,
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
      words,
    });
  }

  return pages;
}

/* -------------------- diff 처리 -------------------- */
function pagesToText(pages) {
  return pages.map((p) => p.words.map((w) => w.text).join(" ")).join("\n");
}

function getAddedWords(diffParts) {
  const added = [];
  for (const part of diffParts) {
    if (part.added) {
      added.push(...part.value.split(/\s+/).filter(Boolean));
    }
  }
  return added;
}

function normalizeToken(t) {
  return (t || "")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .toLowerCase();
}

function mapAddedWordsToPositions(pdf2Pages, addedWords) {
  const hits = [];
  let idx = 0;

  for (const page of pdf2Pages) {
    for (const w of page.words) {
      if (idx >= addedWords.length) return hits;
      if (normalizeToken(w.text) === normalizeToken(addedWords[idx])) {
        hits.push({
          pageNum: page.pageNum,
          viewportWidth: page.viewportWidth,
          viewportHeight: page.viewportHeight,
          x: w.x,
          y: w.y,
          width: Math.max(6, w.width),
          height: Math.max(8, w.height),
        });
        idx++;
      }
    }
  }
  return hits;
}

/* -------------------- pdf-lib: 하이라이트 -------------------- */
async function highlightOnPdf(pdfBytes, hits) {
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const pages = pdfDoc.getPages();

  const byPage = new Map();
  for (const h of hits) {
    if (!byPage.has(h.pageNum)) byPage.set(h.pageNum, []);
    byPage.get(h.pageNum).push(h);
  }

  for (const [pageNum, list] of byPage.entries()) {
    const page = pages[pageNum - 1];
    if (!page) continue;

    const { width: pdfW, height: pdfH } = page.getSize();

    for (const h of list) {
      const scaleX = pdfW / h.viewportWidth;
      const scaleY = pdfH / h.viewportHeight;

      const x = h.x * scaleX;
      const y = pdfH - (h.y * scaleY) - (h.height * scaleY);
      const w = h.width * scaleX;
      const hh = h.height * scaleY;

      page.drawRectangle({
        x,
        y,
        width: w,
        height: hh,
        color: rgb(1, 1, 0),
        opacity: 0.35,
        borderColor: rgb(1, 0.85, 0),
        borderWidth: 0.5,
      });
    }
  }

  return await pdfDoc.save();
}

/* -------------------- 다운로드 -------------------- */
function downloadBytes(bytes, filename) {
  const blob = new Blob([bytes], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* -------------------- 버튼 이벤트 -------------------- */
$("run").addEventListener("click", async () => {
  $("log").textContent = "";
  $("prog").value = 0;
  $("status").textContent = "";

  const fileA = $("pdfA").files?.[0];
  const fileB = $("pdfB").files?.[0];

  if (!fileA || !fileB) {
    alert("PDF1, PDF2를 모두 선택해줘.");
    return;
  }

  try {
    setStatus("파일 로딩...", 5);
    log("PDF 로딩 시작");

    // ⚠️ 핵심: pdf.js / pdf-lib 용 버퍼를 완전히 분리
    const [bytesA, bytesB] = await Promise.all([
      fileToUint8Array(fileA),
      fileToUint8Array(fileB),
    ]);

    const pagesA = await extractWordsWithPositions(bytesA.slice(), "PDF1");
    const pagesB = await extractWordsWithPositions(bytesB.slice(), "PDF2");

    setStatus("단어 비교...", 70);
    const diffParts = diffWords(pagesToText(pagesA), pagesToText(pagesB));
    const addedWords = getAddedWords(diffParts);

    log(`추가된 단어 수: ${addedWords.length}`);
    if (!addedWords.length) {
      alert("추가된 단어가 없습니다.");
      return;
    }

    setStatus("좌표 매핑...", 85);
    const hits = mapAddedWordsToPositions(pagesB, addedWords);
    log(`하이라이트 수: ${hits.length}`);

    setStatus("PDF 생성...", 95);
    const outBytes = await highlightOnPdf(bytesB.slice(), hits);

    downloadBytes(outBytes, "highlighted.pdf");
    setStatus("완료", 100);
    log("완료: highlighted.pdf 다운로드");
  } catch (e) {
    console.error(e);
    log("ERROR: " + e.message);
    alert("에러 발생. 콘솔 확인.");
  }
});
