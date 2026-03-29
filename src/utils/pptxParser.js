/**
 * PPTX Parser v2 - Extract complete shape data from PPTX for Canvas rendering
 * 
 * Extracts: shapes, text, positions, colors, fonts, backgrounds, images
 * Output: structured data ready for Canvas SlideRenderer
 */

import JSZip from 'jszip';

// EMU to pixels (standard 16:9 slide: 12192000 x 6858000 EMU → 960 x 540 px)
const SLIDE_W_EMU = 12192000;
const SLIDE_H_EMU = 6858000;
const CANVAS_W = 960;
const CANVAS_H = 540;

function emuToX(emu) { return (emu / SLIDE_W_EMU) * CANVAS_W; }
function emuToY(emu) { return (emu / SLIDE_H_EMU) * CANVAS_H; }
function emuToW(emu) { return (emu / SLIDE_W_EMU) * CANVAS_W; }
function emuToH(emu) { return (emu / SLIDE_H_EMU) * CANVAS_H; }
function halfPtToPx(hp) { return hp / 100; } // sz attribute is in half-points

const NS = {
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  p: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
};

/**
 * Get direct text content of an element
 */
function getTextContent(el) {
  return el ? el.textContent.trim() : '';
}

/**
 * Get a single child element by tag and namespace
 */
function getChild(parent, tag, ns = NS.a) {
  return parent ? parent.getElementsByTagNameNS(ns, tag)[0] : null;
}

/**
 * Get all child elements by tag and namespace
 */
function getChildren(parent, tag, ns = NS.a) {
  return parent ? Array.from(parent.getElementsByTagNameNS(ns, tag)) : [];
}

/**
 * Get an attribute value, handling namespace prefixes
 */
function getAttr(el, name) {
  return el?.getAttribute(name) || '';
}

/**
 * Parse a color from a fill element
 */
function parseColor(fillEl) {
  if (!fillEl) return null;
  
  const srgb = getChild(fillEl, 'srgbClr');
  if (srgb) {
    const alpha = getChild(srgb, 'alpha');
    const a = alpha ? parseInt(getAttr(alpha, 'val')) / 100000 : 1;
    return { type: 'solid', color: '#' + getAttr(srgb, 'val'), alpha: a };
  }
  
  return null;
}

/**
 * Parse shape geometry
 */
function parseGeom(spPr) {
  const prstGeom = getChild(spPr, 'prstGeom');
  if (prstGeom) {
    return { type: getAttr(prstGeom, 'prst') || 'rect' };
  }
  return { type: 'custom' };
}

/**
 * Parse xfrm (transform) to get position and size
 */
function parseXfrm(spPr) {
  const xfrm = getChild(spPr, 'xfrm');
  if (!xfrm) return null;
  
  const off = getChild(xfrm, 'off');
  const ext = getChild(xfrm, 'ext');
  
  return {
    x: off ? parseInt(getAttr(off, 'x') || '0') : 0,
    y: off ? parseInt(getAttr(off, 'y') || '0') : 0,
    cx: ext ? parseInt(getAttr(ext, 'cx') || '0') : 0,
    cy: ext ? parseInt(getAttr(ext, 'cy') || '0') : 0,
  };
}

/**
 * Parse line properties
 */
function parseLine(lnEl) {
  if (!lnEl) return null;
  return {
    width: parseInt(getAttr(lnEl, 'w') || '12700'),
    color: parseColor(getChild(lnEl, 'solidFill')),
    dash: getAttr(getChild(lnEl, 'prstDash'), 'val') || 'solid',
  };
}

/**
 * Parse text body (txBody) into paragraphs of runs
 */
function parseTxBody(txBodyEl) {
  if (!txBodyEl) return null;
  
  const paragraphs = [];
  const pEls = getChildren(txBodyEl, 'p');
  
  for (const pEl of pEls) {
    const para = { align: 'left', runs: [] };
    
    // Paragraph properties
    const pPr = getChild(pEl, 'pPr', NS.a);
    if (pPr) {
      const algn = getAttr(pPr, 'algn');
      if (algn) para.align = algn;
    }
    
    // Runs
    const rEls = getChildren(pEl, 'r');
    for (const rEl of rEls) {
      const run = { text: getTextContent(getChild(rEl, 't')) };
      if (!run.text) continue;
      
      const rPr = getChild(rEl, 'rPr');
      if (rPr) {
        run.size = halfPtToPx(parseInt(getAttr(rPr, 'sz') || '0'));
        run.bold = getAttr(rPr, 'b') === '1';
        run.italic = getAttr(rPr, 'i') === '1';
        run.underline = getAttr(rPr, 'u') || '';
        run.font = getAttr(getChild(rPr, 'latin'), 'typeface') || '';
        
        const fill = parseColor(getChild(rPr, 'solidFill'));
        if (fill) run.color = fill.color;
      }
      
      para.runs.push(run);
    }
    
    // Also check for field elements (like slide numbers)
    const fldEls = getChildren(pEl, 'fld');
    for (const fldEl of fldEls) {
      const t = getTextContent(getChild(fldEl, 't'));
      if (t) para.runs.push({ text: t });
    }
    
    paragraphs.push(para);
  }
  
  return paragraphs;
}

/**
 * Parse body properties for text anchoring
 */
function parseBodyPr(txBodyEl) {
  const bodyPr = getChild(txBodyEl, 'bodyPr');
  return {
    anchor: bodyPr ? (getAttr(bodyPr, 'anchor') || 't') : 't', // t=top, ctr=center, b=bottom
    wrap: bodyPr ? (getAttr(bodyPr, 'wrap') || 'square') : 'square',
  };
}

/**
 * Parse fill from spPr
 */
function parseFill(spPr) {
  const solidFill = getChild(spPr, 'solidFill');
  if (solidFill) return parseColor(solidFill);
  
  const noFill = getChild(spPr, 'noFill');
  if (noFill) return { type: 'none' };
  
  return null;
}

/**
 * Parse background from slide
 */
function parseBackground(sld) {
  const bg = getChild(sld, 'bg', NS.p);
  if (!bg) return null;
  
  const bgPr = getChild(bg, 'bgPr', NS.p);
  if (!bgPr) return null;
  
  const solidFill = getChild(bgPr, 'solidFill');
  if (solidFill) return parseColor(solidFill);
  
  return null;
}

/**
 * Parse a single shape (sp) element
 */
function parseShape(spEl) {
  const nvSpPr = getChild(spEl, 'nvSpPr', NS.p);
  const spPr = getChild(spEl, 'spPr', NS.p);
  const txBody = getChild(spEl, 'txBody', NS.p);
  
  // Shape identity
  const cNvPr = getChild(nvSpPr, 'cNvPr', NS.p);
  const id = cNvPr ? parseInt(getAttr(cNvPr, 'id') || '0') : 0;
  const name = cNvPr ? getAttr(cNvPr, 'name') || '' : '';
  
  // Check if it's a line shape
  const geom = parseGeom(spPr);
  const xfrm = parseXfrm(spPr);
  const fill = parseFill(spPr);
  const ln = parseLine(getChild(spPr, 'ln'));
  
  // Shadow
  const effectLst = getChild(spPr, 'effectLst');
  let shadow = null;
  if (effectLst) {
    const outerShdw = getChild(effectLst, 'outerShdw');
    if (outerShdw) {
      shadow = {
        blur: parseInt(getAttr(outerShdw, 'blur') || '0') / 12700,
        offset: parseInt(getAttr(outerShdw, 'dist') || '0') / 12700,
        color: parseColor(getChild(outerShdw, 'srgbClr')),
      };
    }
  }
  
  const shape = {
    id,
    name,
    type: geom.type,
    xfrm: xfrm ? {
      x: emuToX(xfrm.x),
      y: emuToY(xfrm.y),
      w: emuToW(xfrm.cx),
      h: emuToH(xfrm.cy),
      rawX: xfrm.x,
      rawY: xfrm.y,
      rawW: xfrm.cx,
      rawH: xfrm.cy,
    } : null,
    fill,
    line: ln,
    shadow,
    text: null,
    bodyPr: null,
    isTextOnly: false,
  };
  
  // Parse text content
  if (txBody) {
    const paras = parseTxBody(txBody);
    shape.text = paras;
    shape.bodyPr = parseBodyPr(txBody);
    shape.isTextOnly = paras && paras.length > 0;
  }
  
  return shape;
}

/**
 * Parse a connector/line (cxnSp) element
 */
function parseConnector(cxnEl) {
  const spPr = getChild(cxnEl, 'spPr', NS.p);
  const xfrm = parseXfrm(spPr);
  const ln = parseLine(getChild(spPr, 'ln'));
  const geom = parseGeom(spPr);
  
  return {
    type: 'line',
    xfrm: xfrm ? {
      x: emuToX(xfrm.x),
      y: emuToY(xfrm.y),
      w: emuToW(xfrm.cx),
      h: emuToH(xfrm.cy),
    } : null,
    line: ln,
    lineType: geom.type, // 'line' or 'bentConnector' etc
  };
}

/**
 * Parse a picture (pic) element
 */
function parsePicture(picEl, rels) {
  const spPr = getChild(picEl, 'spPr', NS.p);
  const xfrm = parseXfrm(spPr);
  
  // Get image reference
  const blipFill = getChild(picEl, 'blipFill', NS.p);
  let imageRId = null;
  if (blipFill) {
    const blip = getChild(blipFill, 'blip');
    if (blip) {
      imageRId = getAttr(blip, 'r:embed') || blip.getAttributeNS(NS.r, 'embed');
    }
  }
  
  return {
    type: 'image',
    xfrm: xfrm ? {
      x: emuToX(xfrm.x),
      y: emuToY(xfrm.y),
      w: emuToW(xfrm.cx),
      h: emuToH(xfrm.cy),
    } : null,
    imageRId,
    relTarget: imageRId && rels ? (rels[imageRId] || null) : null,
  };
}

/**
 * Parse slide relationships
 */
function parseRels(relsXml) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(relsXml, 'application/xml');
  const rels = {};
  
  const relEls = doc.getElementsByTagName('Relationship');
  for (const rel of relEls) {
    const id = rel.getAttribute('Id');
    const target = rel.getAttribute('Target');
    if (id) rels[id] = target;
  }
  
  return rels;
}

/**
 * Main: Parse a PPTX file into structured slide data
 */
export async function parsePPTX(arrayBuffer) {
  const zip = await JSZip.loadAsync(arrayBuffer);
  
  // Get sorted slide files
  const slideFiles = Object.keys(zip.files)
    .filter(f => /^ppt\/slides\/slide(\d+)\.xml$/.test(f))
    .sort((a, b) => {
      const numA = parseInt(a.match(/slide(\d+)/)[1]);
      const numB = parseInt(b.match(/slide(\d+)/)[1]);
      return numA - numB;
    });
  
  const slides = [];
  
  for (const slideFile of slideFiles) {
    // Parse slide XML
    const xmlStr = await zip.files[slideFile].async('text');
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlStr, 'application/xml');
    
    // Parse relationships for this slide
    const relsFile = slideFile.replace('ppt/slides/', 'ppt/slides/_rels/') + '.rels';
    let rels = {};
    if (zip.files[relsFile]) {
      const relsXml = await zip.files[relsFile].async('text');
      rels = parseRels(relsXml);
    }
    
    // Extract image files
    const images = {};
    for (const [rId, target] of Object.entries(rels)) {
      if (target && (target.includes('media/') || target.includes('../media/'))) {
        const mediaPath = target.startsWith('../') 
          ? 'ppt/' + target.substring(3)
          : 'ppt/slides/' + target;
        if (zip.files[mediaPath]) {
          const blob = await zip.files[mediaPath].async('blob');
          images[rId] = URL.createObjectURL(blob);
        }
      }
    }
    
    // Get spTree
    const cSld = doc.getElementsByTagNameNS(NS.p, 'cSld')[0];
    const spTree = cSld ? cSld.getElementsByTagNameNS(NS.p, 'spTree')[0] : null;
    
    // Background
    const background = parseBackground(doc);
    
    // Parse shapes
    const shapes = [];
    const connectors = [];
    const pictures = [];
    
    if (spTree) {
      // Parse sp elements (shapes)
      const spEls = spTree.getElementsByTagNameNS(NS.p, 'sp');
      for (const spEl of spEls) {
        // Skip the group shape properties container
        const nvGrpSpPr = getChild(spEl, 'nvGrpSpPr', NS.p);
        if (nvGrpSpPr) continue;
        
        const shape = parseShape(spEl);
        shapes.push(shape);
      }
      
      // Parse cxnSp elements (connectors/lines)
      const cxnEls = spTree.getElementsByTagNameNS(NS.p, 'cxnSp');
      for (const cxnEl of cxnEls) {
        connectors.push(parseConnector(cxnEl));
      }
      
      // Parse pic elements (pictures)
      const picEls = spTree.getElementsByTagNameNS(NS.p, 'pic');
      for (const picEl of picEls) {
        pictures.push(parsePicture(picEl, rels));
      }
    }
    
    slides.push({
      background,
      shapes,
      connectors,
      pictures,
      images,
    });
  }
  
  return {
    canvasWidth: CANVAS_W,
    canvasHeight: CANVAS_H,
    slides,
  };
}
