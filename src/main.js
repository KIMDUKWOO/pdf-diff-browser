import * as pdfjsLib from "pdfjs-dist";
import { PDFDocument, rgb } from "pdf-lib";
import { diffWords } from "diff";

// ✅ Vite(브라우저 번들)에서 worker 설정
import pdfWorker from "pdfjs-dist/build/pdf.worker?url";
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

const $ = (id) => document.getElementById(id);

const log = (msg) => {
  const el = $("log");
  el.textContent += (el.textContent ? "\n" : "") + msg;
};

const setStatus = (msg, p = null) => {
  $("status").textContent = msg ?? "";
  if (p !== null) $("prog").value = p;
};

// 파일 → ArrayBuffer
async function fileToArrayBuffer(file) {
  return await file.arrayBuffer();
}

// pdf.js로 페이지별 “단어 + 좌표(뷰포트 기준)” 뽑기
async function extractWordsWithPositions(arrayBuffer, label) {
  const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
  const pdf = await loadingTask.promise;

  const pages = [];
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    setStatus(`${label}: 텍스트 추출 중... (page ${pageNum}/${pdf.numPages})`, Math.round((pageNum / pdf.numPages) * 40));

    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1.0 });

    const content = await page.getTextContent();
    const words = [];

    for (const item of content.items) {
      const str = (item.str || "").trim();
      if (!str) continue;

      // item.transform: [a, b, c, d, e, f]
      // e,f가 좌하단 기준 위치(뷰포트 좌표계). 높이는 item.height 참고.
      const [a, b, c, d, e, f] = item.transform;

      // 간단 토크나이즈: 공백 단위로 쪼개되, 위치는 일단 같은 박스로 둠(정밀화 가능)
      // 정밀 하이라이트 B버전을 이미 갖고 있다면 여기만 그 로직으로 교체하면 됨.
      const parts = str.split(/\s+/).filter(Boolean);

      const fontHeight = item.height || Math.abs(d) || 10;
      const boxWidth = item.width || 0;

      // item 하나가 여러 단어면 폭을 대략 분배
      const approxWordWidth = parts.length > 0 && boxWidth > 0 ? boxWidth / parts.length : boxWidth;

      for (let i = 0; i < parts.length; i++) {
        const w = parts[i];
        // 단어별로 x를 대략 이동(정밀 버전에서는 실제 glyph 기반으로 계산)
        const x = e + i * approxWordWidth;
        const y = f;

        words.push({
          text: w,
          // pdf.js viewport 좌표(좌상단 원점이 아니라 좌하단 기반 느낌이지만, pdf-lib 변환에서 처리)
          // 여기서는 “뷰포트 기준”으로 저장
          x,
          y,
          width: approxWordWidth || item.width || 0,
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

// 페이지별 단어 텍스트만 이어붙이기
function pagesToText(pages) {
  // 페이지 구분용 토큰(페이지 넘어가면 매칭 혼동 줄이기)
  return pages.map((p) => p.words.map((w) => w.text).join(" ")).join("\n");
}

// diff 결과에서 “추가된 단어 리스트” 뽑기
function getAddedWords(diffParts) {
  const added = [];
  for (const part of diffParts) {
    if (part.added) {
      const ws = part.value.split(/\s+/).filter(Boolean);
      added.push(...ws);
    }
  }
  return added;
}

// PDF2 페이지들의 words에서 “addedWords”를 순서대로 찾아 좌표 리스트로 변환
function mapAddedWordsToPositions(pdf2Pages, addedWords) {
  // 매우 단순한 순차 매칭(정밀/견고 버전에서는 토큰 정규화/유사도/페이지 경계 처리 강화)
  const hits = [];
  let idx = 0;

  for (const page of pdf2Pages) {
    for (const w of page.words) {
      if (idx >= addedWords.length) return hits;

      // 비교를 조금 완화(문장부호 제거 등은 여기서 확장 가능)
      const a = addedWords[idx];
      if (normalizeToken(w.text) === normalizeToken(a)) {
        hits.push({
          pageNum: page.pageNum,
          viewportWidth: page.viewportWidth,
          viewportHeight: page.viewportHeight,
          x: w.x,
          y: w.y,
          width: Math.max(6, w.width),
          height: Math.max(8, w.height),
          text: w.text,
        });
        idx++;
      }
    }
  }
  return hits;
}

function normalizeToken(t) {
  return (t || "")
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, "") // 문자/숫자만 남김(한글 포함)
    .toLowerCase();
}

// pdf-lib: PDF2 위에 하이라이트(사각형) 그려서 새 PDF 생성
async function highlightOnPdf(pdf2ArrayBuffer, hits) {
  const pdfDoc = await PDFDocument.load(pdf2ArrayBuffer);
  const pages = pdfDoc.getPages();

  // 같은 페이지끼리 묶기
  const byPage = new Map();
  for (const h of hits) {
    if (!byPage.has(h.pageNum)) byPage.set(h.pageNum, []);
    byPage.get(h.pageNum).push(h);
  }

  for (const [pageNum, list] of byPage.entries()) {
    const pageIndex = pageNum - 1;
    const page = pages[pageIndex];
    if (!page) continue;

    const { width: pdfW, height: pdfH } = page.getSize();

    for (const h of list) {
      // pdf.js viewport 좌표 → pdf-lib 좌표로 변환
      // pdf-lib는 좌하단 원점. pdf.js에서 얻은 (x,y)는 뷰포트 기준 “좌하단 느낌”이라
      // 실제 문서에 따라 뒤집힘이 생길 수 있음. (정밀 B버전에서는 여기 변환이 핵심)
      // 여기서는 보수적으로 y를 “페이지 높이 - y”로 뒤집는 방식 사용.
      const scaleX = pdfW / h.viewportWidth;
      const scaleY = pdfH / h.viewportHeight;

      const x = h.x * scaleX;
      const yFromBottom = (h.y - h.height) * scaleY;
      const y = pdfH - yFromBottom - (h.height * scaleY); // y 뒤집기

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

// 다운로드
function downloadBytes(bytes, filename) {
  const blob = new Blob([bytes], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$("run").addEventListener("click", async () => {
  const fileA = $("pdfA").files?.[0];
  const fileB = $("pdfB").files?.[0];

  $("log").textContent = "";
  $("prog").value = 0;
  $("status").textContent = "";

  if (!fileA || !fileB) {
    alert("PDF1(기준), PDF2(대상) 파일을 둘 다 선택해줘.");
    return;
  }

  try {
    setStatus("파일 로딩...", 1);
    log("PDF 로딩 시작");

    const [abA, abB] = await Promise.all([fileToArrayBuffer(fileA), fileToArrayBuffer(fileB)]);

    setStatus("PDF1 텍스트/좌표 추출...", 5);
    const pagesA = await extractWordsWithPositions(abA, "PDF1");

    setStatus("PDF2 텍스트/좌표 추출...", 45);
    const pagesB = await extractWordsWithPositions(abB, "PDF2");

    setStatus("단어 비교(diff)...", 70);
    const textA = pagesToText(pagesA);
    const textB = pagesToText(pagesB);

    const diffParts = diffWords(textA, textB);
    const addedWords = getAddedWords(diffParts);

    log(`추가된 단어 수(대략): ${addedWords.length}`);
    if (addedWords.length === 0) {
      setStatus("추가된 단어가 없습니다.", 100);
      alert("PDF2에서 추가된 단어가 감지되지 않았어.");
      return;
    }

    setStatus("좌표 매핑...", 80);
    const hits = mapAddedWordsToPositions(pagesB, addedWords);
    log(`매핑된 하이라이트 수(대략): ${hits.length}`);

    setStatus("PDF 하이라이트 그리는 중...", 90);
    const outBytes = await highlightOnPdf(abB, hits);

    setStatus("완료! 다운로드 시작", 100);
    downloadBytes(outBytes, "highlighted.pdf");
    log("완료: highlighted.pdf 다운로드");
  } catch (e) {
    console.error(e);
    log("ERROR: " + (e?.message || String(e)));
    setStatus("에러 발생", 0);
    alert("에러가 발생했어. 콘솔과 로그를 확인해줘.");
  }
});
