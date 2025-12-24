import * as pdfjsLib from "pdfjs-dist";
import { PDFDocument, rgb } from "pdf-lib";
import { diffChars } from "diff";

// ✅ GitHub Pages 안전 worker 경로
// public/pdfjs/pdf.worker.min.mjs 를 사용
pdfjsLib.GlobalWorkerOptions.workerSrc =
  import.meta.env.BASE_URL + "pdfjs/pdf.worker.min.mjs";

/* -------------------- UI utils -------------------- */
const $ = (id) => document.getElementById(id);

const log = (m) => {
  const el = $("log");
  el.textContent += (el.textContent ? "\n" : "") + m;
};

const setStatus = (m, p = null) => {
  $("status").textContent = m ?? "";
  if (p !== null) $("prog").value = p;
};

function clearUI() {
  $("log").textContent = "";
  $("prog").value = 0;
  $("status").textContent = "";
}

/* -------------------- bytes -------------------- */
async function fileToBytes(file) {
  return new Uint8Array(await file.arrayBuffer());
}

/* -------------------- text normalization -------------------- */
// diff 매칭 안정화를 위해 “비교용 텍스트”는 정규화, 하지만 실제 좌표는 원문 기준으로 유지
function normForCompare(s) {
  return (s || "")
    .normalize("NFKC")
    .replace(/\u00ad/g, "")          // soft hyphen 제거
    .replace(/-\s*\n/g, "")          // 줄바꿈 하이픈 결합 케이스 보정(있으면)
    .replace(/\s+/g, " ")
    .trim();
}

/* -------------------- PDF parsing: items -> lines -------------------- */
/**
 * pdf.js text item:
 * - item.str, item.transform([a,b,c,d,e,f]), item.width, item.height
 * 여기서 e,f가 위치. item.width는 문자열 전체 폭.
 */
async function extractLines(pdfBytes, label) {
  const pdf = await pdfjsLib.getDocument({ data: pdfBytes }).promise;
  const allPages = [];

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    setStatus(`${label}: 텍스트 추출 (page ${pageNum}/${pdf.numPages})`, Math.round((pageNum / pdf.numPages) * 35));

    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1 });

    const content = await page.getTextContent({ disableCombineTextItems: true });
    const items = [];

    for (const it of content.items) {
      const str = (it.str || "").trim();
      if (!str) continue;

      const [, , , d, x, y] = it.transform;
      const h = it.height || Math.abs(d) || 10;
      const w = it.width || estimateTextWidth(str, h);

      items.push({
        str,
        x,
        y,
        width: w,
        height: h,
      });
    }

    // line grouping by y (tolerance)
    const lines = groupItemsToLines(items, {
      yTolerance: 2.5,
      joinSpaceThreshold: 2.0,
    });

    // store
    for (const line of lines) {
      allPages.push({
        pageNum,
        viewportWidth: viewport.width,
        viewportHeight: viewport.height,
        y: line.y,
        items: line.items,
        text: line.text,             // 원문 조합
        cmpText: normForCompare(line.text), // 비교용
        // line 폭 정보(문자 박스 근사에 사용)
        approxX0: line.x0,
        approxX1: line.x1,
      });
    }
  }

  return allPages;
}

// 대충 글자폭을 추정(폭 정보가 없을 때만)
function estimateTextWidth(str, fontHeight) {
  // 라틴 기준 0.55em, 한글은 조금 더 넓게 근사
  const hasCJK = /[\u3131-\uD79D]/.test(str);
  const factor = hasCJK ? 0.95 : 0.55;
  return Math.max(6, str.length * fontHeight * factor);
}

function groupItemsToLines(items, { yTolerance, joinSpaceThreshold }) {
  // 1) y 기준으로 군집
  items.sort((a, b) => b.y - a.y || a.x - b.x);

  const lines = [];
  for (const it of items) {
    let line = null;
    for (const ln of lines) {
      if (Math.abs(ln.y - it.y) <= yTolerance) {
        line = ln;
        break;
      }
    }
    if (!line) {
      line = { y: it.y, items: [] };
      lines.push(line);
    }
    line.items.push(it);
  }

  // 2) 각 라인 내부 x 정렬 + 텍스트 조합
  for (const ln of lines) {
    ln.items.sort((a, b) => a.x - b.x);

    let text = "";
    let x0 = Infinity;
    let x1 = -Infinity;

    for (let i = 0; i < ln.items.length; i++) {
      const cur = ln.items[i];
      x0 = Math.min(x0, cur.x);
      x1 = Math.max(x1, cur.x + cur.width);

      if (i === 0) {
        text += cur.str;
        continue;
      }

      const prev = ln.items[i - 1];
      const gap = cur.x - (prev.x + prev.width);
      if (gap > joinSpaceThreshold) text += " ";
      text += cur.str;
    }

    ln.text = text;
    ln.x0 = isFinite(x0) ? x0 : 0;
    ln.x1 = isFinite(x1) ? x1 : 0;
  }

  // 위에서 y 기준 매칭이 “먼저 들어간 ln.y”라 약간 들쭉날쭉할 수 있어 평균으로 보정
  for (const ln of lines) {
    const avgY = ln.items.reduce((s, it) => s + it.y, 0) / ln.items.length;
    ln.y = avgY;
  }

  // y 순서 정렬(위→아래)
  lines.sort((a, b) => b.y - a.y);

  return lines;
}

/* -------------------- line pairing -------------------- */
/**
 * 페이지 기반 + y 근접 기반으로 라인을 페어링 (드리프트 크게 줄임)
 * - 같은 pageNum끼리 먼저 매칭
 * - y가 가장 가까운 라인을 선택
 * - 이미 매칭된 라인은 재사용하지 않음
 */
function pairLines(linesA, linesB) {
  const mapAByPage = new Map();
  for (const ln of linesA) {
    if (!mapAByPage.has(ln.pageNum)) mapAByPage.set(ln.pageNum, []);
    mapAByPage.get(ln.pageNum).push(ln);
  }
  for (const arr of mapAByPage.values()) arr.sort((a, b) => b.y - a.y);

  const usedA = new Set();
  const pairs = [];

  for (const lnB of linesB) {
    const candidates = mapAByPage.get(lnB.pageNum) || [];
    let best = null;
    let bestScore = Infinity;

    for (const lnA of candidates) {
      if (usedA.has(lnA)) continue;

      // y 근접 + 텍스트 길이 차이를 같이 반영
      const dy = Math.abs(lnA.y - lnB.y);
      const dl = Math.abs(lnA.cmpText.length - lnB.cmpText.length);
      const score = dy * 3 + dl * 0.2;

      if (score < bestScore) {
        bestScore = score;
        best = lnA;
      }
    }

    if (best) {
      usedA.add(best);
      pairs.push([best, lnB]);
    } else {
      // 대응 라인이 없으면 B만(추가로 취급)
      pairs.push([null, lnB]);
    }
  }

  return pairs;
}

/* -------------------- char-level diff -> highlight boxes -------------------- */
/**
 * 핵심: diffChars로 “추가된 문자” 위치(인덱스 범위)를 얻고,
 * 그 문자 범위를 line의 x범위로 “문자 폭 비율”로 매핑해서 박스 생성
 *
 * 정확도는 item.width 기반(텍스트 폭) + 공백 삽입 규칙(라인 조합) 품질에 따라 좌우됨.
 */
function highlightFromCharDiff(pairs) {
  const boxes = [];

  for (const [lnA, lnB] of pairs) {
    const a = lnA ? lnA.cmpText : "";
    const b = lnB.cmpText;

    if (!b) continue;

    const diff = diffChars(a, b);

    // b 문자열에서의 현재 인덱스
    let bIndex = 0;

    for (const part of diff) {
      const val = part.value || "";
      if (part.added) {
        const start = bIndex;
        const end = bIndex + val.length;
        if (end > start) {
          // (start,end) 문자 범위를 박스로 변환
          boxes.push(...charRangeToBoxes(lnB, start, end));
        }
      }

      // removed는 bIndex가 증가하지 않음
      if (!part.removed) {
        bIndex += val.length;
      }
    }
  }

  return mergeBoxes(boxes);
}

/**
 * lnB: line object, start/end: lnB.cmpText 기준 인덱스
 * 반환: 한 라인에서 여러 박스(필요하면 여러 개) - 지금은 단일 박스(문자범위)로 생성
 */
function charRangeToBoxes(lnB, start, end) {
  // line의 비교 텍스트(b.cmpText)는 normForCompare로 공백정리가 됨
  // 실제 lnB.text와 완전 1:1은 아니지만, “폭 비율” 근사로 상당히 좋아짐.
  const textLen = lnB.cmpText.length || 1;

  // line의 x범위는 item들의 x0~x1로 근사
  const x0 = lnB.approxX0;
  const x1 = lnB.approxX1;
  const lineW = Math.max(1, x1 - x0);

  const r0 = start / textLen;
  const r1 = end / textLen;

  const x = x0 + lineW * r0;
  const w = Math.max(2, lineW * (r1 - r0));

  // y/height는 라인 아이템들의 평균/최대로 근사
  const y = lnB.y;
  const h = Math.max(8, ...lnB.items.map((it) => it.height || 8));

  return [{
    pageNum: lnB.pageNum,
    viewportWidth: lnB.viewportWidth,
    viewportHeight: lnB.viewportHeight,
    x,
    y,
    width: w,
    height: h,
  }];
}

/* -------------------- merge boxes (same line) -------------------- */
function mergeBoxes(boxes) {
  // 페이지, y 근접, x 순으로 정렬
  boxes.sort((a, b) => {
    if (a.pageNum !== b.pageNum) return a.pageNum - b.pageNum;
    const dy = a.y - b.y;
    if (Math.abs(dy) > 2) return dy;
    return a.x - b.x;
  });

  const out = [];
  for (const b of boxes) {
    const last = out[out.length - 1];
    if (
      last &&
      last.pageNum === b.pageNum &&
      Math.abs(last.y - b.y) <= 2.5 &&
      b.x <= last.x + last.width + 3
    ) {
      // 병합
      const newX1 = Math.max(last.x + last.width, b.x + b.width);
      last.width = newX1 - last.x;
      last.height = Math.max(last.height, b.height);
    } else {
      out.push({ ...b });
    }
  }
  return out;
}

/* -------------------- pdf-lib render -------------------- */
async function renderHighlights(pdfBytes, boxes) {
  const doc = await PDFDocument.load(pdfBytes);
  const pages = doc.getPages();

  for (const b of boxes) {
    const page = pages[b.pageNum - 1];
    if (!page) continue;

    const { width: pw, height: ph } = page.getSize();
    const sx = pw / b.viewportWidth;
    const sy = ph / b.viewportHeight;

    const x = b.x * sx;
    const y = ph - (b.y * sy) - (b.height * sy);

    page.drawRectangle({
      x,
      y,
      width: b.width * sx,
      height: b.height * sy,
      color: rgb(1, 1, 0),
      opacity: 0.35,
      borderColor: rgb(1, 0.85, 0),
      borderWidth: 0.5,
    });
  }

  return await doc.save();
}

function download(bytes, filename) {
  const blob = new Blob([bytes], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* -------------------- main -------------------- */
window.addEventListener("DOMContentLoaded", () => {
  log("✅ precision(char-level) main.js loaded");
});

$("run").addEventListener("click", async () => {
  clearUI();

  const fileA = $("pdfA").files?.[0];
  const fileB = $("pdfB").files?.[0];

  if (!fileA || !fileB) {
    alert("PDF1, PDF2를 모두 선택해줘.");
    return;
  }

  try {
    setStatus("파일 로딩...", 5);
    log("PDF 로딩 시작");

    // ✅ detached 방지: pdf.js / pdf-lib용 분리
    const [bytesA, bytesB] = await Promise.all([fileToBytes(fileA), fileToBytes(fileB)]);

    setStatus("PDF1 라인 추출...", 15);
    const linesA = await extractLines(bytesA.slice(), "PDF1");

    setStatus("PDF2 라인 추출...", 45);
    const linesB = await extractLines(bytesB.slice(), "PDF2");

    setStatus("라인 매칭...", 60);
    const pairs = pairLines(linesA, linesB);

    setStatus("문자 단위 diff...", 75);
    const boxes = highlightFromCharDiff(pairs);
    log(`하이라이트 박스 수(병합 후): ${boxes.length}`);

    setStatus("PDF 렌더링...", 90);
    const out = await renderHighlights(bytesB.slice(), boxes);

    setStatus("완료! 다운로드", 100);
    download(out, "highlighted.pdf");
    log("완료: highlighted.pdf 다운로드");
  } catch (e) {
    console.error(e);
    log("ERROR: " + (e?.message || String(e)));
    alert("에러 발생. 콘솔(F12) 확인.");
  }
});
