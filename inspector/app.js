const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const resultView = document.getElementById('result-view');
const previewImage = document.getElementById('preview-image');
const resetBtn = document.getElementById('reset-btn');

// UI Elements
const badgeContainer = document.getElementById('tool-badge-container');
const contentPositive = document.getElementById('content-positive');
const contentNegative = document.getElementById('content-negative');
const labelPositive = document.getElementById('label-positive');
const labelNegative = document.getElementById('label-negative');
const metaGrid = document.getElementById('meta-grid');
const contentRaw = document.getElementById('content-raw');

// Listeners
dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
});

fileInput.addEventListener('change', (e) => {
    if (e.target.files.length) handleFile(e.target.files[0]);
});

resetBtn.addEventListener('click', () => {
    resultView.classList.remove('visible');
    setTimeout(() => {
        dropZone.classList.remove('hidden');
        resetUI();
    }, 300);
});

function resetUI() {
    contentPositive.innerText = '';
    contentNegative.innerText = '';
    metaGrid.innerHTML = '';
    contentRaw.innerText = '';
    badgeContainer.innerHTML = '';
}

async function handleFile(file) {
    if (!file.type.startsWith('image/')) return;

    // Show preview
    const reader = new FileReader();
    reader.onload = (e) => {
        previewImage.src = e.target.result;
        dropZone.classList.add('hidden');
        resultView.classList.add('visible');
    };
    reader.readAsDataURL(file);

    // Parse Metadata
    try {
        const buffer = await file.arrayBuffer();
        const metadata = await parseMetadata(buffer);
        displayMetadata(metadata);
    } catch (err) {
        console.error("File processing error", err);
        alert("画像の解析中にエラーが発生しました。");
    }
}

async function parseMetadata(buffer) {
    const view = new DataView(buffer);
    
    // Check PNG Header
    if (view.getUint32(0) !== 0x89504E47 || view.getUint32(4) !== 0x0D0A1A0A) {
        return { error: 'Not a standard PNG file' };
    }

    let offset = 8;
    const chunks = {};
    const textDecoder = new TextDecoder('utf-8');
    const latin1Decoder = new TextDecoder('iso-8859-1');

    while (offset < buffer.byteLength) {
        const length = view.getUint32(offset);
        const type = textDecoder.decode(buffer.slice(offset + 4, offset + 8));
        const dataOffset = offset + 8;

        if (type === 'tEXt') {
            const chunkData = new Uint8Array(buffer, dataOffset, length);
            const nullIndex = chunkData.indexOf(0);
            if (nullIndex !== -1) {
                const key = latin1Decoder.decode(chunkData.slice(0, nullIndex));
                const text = latin1Decoder.decode(chunkData.slice(nullIndex + 1));
                try {
                    chunks[key] = decodeURIComponent(escape(text));
                } catch (e) { chunks[key] = text; }
            }
        }
        else if (type === 'zTXt') {
            const chunkData = new Uint8Array(buffer, dataOffset, length);
            const nullIndex = chunkData.indexOf(0);
            if (nullIndex !== -1) {
                const key = latin1Decoder.decode(chunkData.slice(0, nullIndex));
                chunks[key] = await decompress(chunkData.slice(nullIndex + 2));
            }
        }
        else if (type === 'iTXt') {
            const chunkData = new Uint8Array(buffer, dataOffset, length);
            let ptr = chunkData.indexOf(0);
            if (ptr !== -1) {
                const key = textDecoder.decode(chunkData.slice(0, ptr));
                const compFlag = chunkData[++ptr];
                const compMethod = chunkData[++ptr];
                ptr = chunkData.indexOf(0, ++ptr); // lang
                ptr = chunkData.indexOf(0, ++ptr); // trans key
                if (compFlag === 0) chunks[key] = textDecoder.decode(chunkData.slice(++ptr));
                else chunks[key] = await decompress(chunkData.slice(++ptr));
            }
        }

        if (type === 'IEND') break;
        offset += length + 12;
    }
    return chunks;
}

async function decompress(data) {
    try {
        const ds = new DecompressionStream('deflate');
        const writer = ds.writable.getWriter();
        writer.write(data);
        writer.close();
        const response = new Response(ds.readable);
        const buffer = await response.arrayBuffer();
        return new TextDecoder().decode(buffer);
    } catch (e) {
        console.error("Decompression failed", e);
        return "[Compressed Data]";
    }
}

function displayMetadata(data) {
    let source = "Unknown";
    let positive = "";
    let negative = "";
    let params = {};

    // Reset UI Labels
    labelPositive.innerText = "Positive Prompt";
    labelNegative.innerText = "Negative Prompt";

    // 1. Stable Diffusion (A1111)
    if (data["parameters"]) {
        source = "Stable Diffusion";
        const raw = data["parameters"];
        const negIndex = raw.lastIndexOf("\nNegative prompt: ");
        const stepIndex = raw.lastIndexOf("\nSteps: ");
        
        if (negIndex !== -1) {
            positive = raw.substring(0, negIndex).trim();
            if (stepIndex !== -1 && stepIndex > negIndex) {
                negative = raw.substring(negIndex + 18, stepIndex).trim();
                params = parseA1111Params(raw.substring(stepIndex + 1).trim());
            } else {
                negative = raw.substring(negIndex + 18).trim();
            }
        } else if (stepIndex !== -1) {
            positive = raw.substring(0, stepIndex).trim();
            params = parseA1111Params(raw.substring(stepIndex + 1).trim());
        } else {
            positive = raw.trim();
        }
    } 
    // 2. ComfyUI
    else if (isComfyPrompt(data["prompt"])) {
        source = "ComfyUI";
        try {
            const flow = JSON.parse(data["prompt"]);
            const samplers = Object.values(flow).filter(n => 
                n.class_type === "KSampler" || n.class_type === "KSamplerAdvanced"
            );
            if (samplers.length > 0) {
                const s = samplers[0];
                positive = recursiveFindText(flow, s.inputs.positive);
                negative = recursiveFindText(flow, s.inputs.negative);
                params = {
                    Seed: s.inputs.seed || s.inputs.noise_seed,
                    Steps: s.inputs.steps,
                    CFG: s.inputs.cfg,
                    Sampler: s.inputs.sampler_name,
                    Scheduler: s.inputs.scheduler,
                    Denoise: s.inputs.denoise
                };
            } else {
                // Simple search
                const texts = Object.values(flow).filter(n => n.class_type === "CLIPTextEncode");
                if (texts.length > 0) positive = texts[0].inputs.text || texts[0].inputs.prompt;
                if (texts.length > 1) negative = texts[1].inputs.text || texts[1].inputs.prompt;
            }
        } catch (e) { console.error("ComfyUI Parse Error", e); }
    }
    // 3. NovelAI
    else if (data["Software"] === "NovelAI" || data["Source"]?.includes("NovelAI") || data["Comment"]) {
        source = "NovelAI";
        positive = data["Description"] || "";
        labelNegative.innerText = "Undesired Content";
        
        if (data["Comment"]) {
            try {
                const comment = JSON.parse(data["Comment"]);
                negative = comment.uc || "";
                params = {
                    Steps: comment.steps,
                    Sampler: comment.sampler,
                    Seed: comment.seed,
                    Scale: comment.scale,
                    Strength: comment.strength
                };
                if (positive === "" && comment.prompt) positive = comment.prompt;
            } catch (e) {
                if (positive === "") positive = data["Comment"];
            }
        }
    }
    // 4. ANIMA / generic prompt metadata
    else if (hasAnimaPromptMetadata(data)) {
        source = "ANIMA";
        const anima = parseAnimaMetadata(data);
        positive = anima.positive;
        negative = anima.negative;
        params = anima.params;
    }

    // UI Rendering
    badgeContainer.innerHTML = `<span class="tool-badge">${source}</span>`;
    contentPositive.innerText = positive || "(No positive prompt detected)";
    contentNegative.innerText = negative || "(No negative prompt detected)";
    contentRaw.innerText = JSON.stringify(data, null, 2);

    metaGrid.innerHTML = '';
    for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null) continue;
        const item = document.createElement('div');
        item.className = 'meta-item';
        item.innerHTML = `<span class="meta-label">${k}</span><span class="meta-value">${v}</span>`;
        metaGrid.appendChild(item);
    }
}

function isComfyPrompt(value) {
    if (typeof value !== 'string' || value.trim() === '') return false;
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' && Object.values(parsed).some(node =>
            node && typeof node === 'object' && (
                node.class_type ||
                (node.inputs && typeof node.inputs === 'object')
            )
        );
    } catch (e) {
        return false;
    }
}

function hasAnimaPromptMetadata(data) {
    return getFirstMetadataValue(data, [
        'anima_prompt',
        'ANIMA prompt',
        'prompt',
        'positive',
        'positive_prompt',
        'caption',
        'description',
        'Description',
        'ImageDescription',
        'imagedescription',
        'UserComment',
        'usercomment',
        '37510',
        '270'
    ]) !== "";
}

function parseAnimaMetadata(data) {
    let positive = getFirstMetadataValue(data, [
        'anima_prompt',
        'ANIMA prompt',
        'prompt',
        'positive',
        'positive_prompt',
        'caption',
        'description',
        'Description',
        'ImageDescription',
        'imagedescription',
        'UserComment',
        'usercomment',
        '37510',
        '270'
    ]);

    let negative = getFirstMetadataValue(data, [
        'negative',
        'negative_prompt',
        'negative prompt',
        'undesired',
        'uc'
    ]);

    const jsonText = getFirstMetadataValue(data, ['Comment', 'comment', 'metadata', 'generation_data']);
    const parsed = parseJsonObject(jsonText);
    if (parsed) {
        positive = positive || getFirstMetadataValue(parsed, ['prompt', 'positive', 'caption', 'description']);
        negative = negative || getFirstMetadataValue(parsed, ['negative', 'negative_prompt', 'uc', 'undesired']);
    }

    if (positive) {
        const split = splitPromptSections(positive);
        positive = split.positive;
        negative = negative || split.negative;
    }

    const params = collectParams(data, parsed);
    return { positive, negative, params };
}

function getFirstMetadataValue(source, keys) {
    if (!source || typeof source !== 'object') return "";
    const lowerMap = new Map(Object.keys(source).map(key => [key.toLowerCase(), key]));

    for (const key of keys) {
        const actualKey = key in source ? key : lowerMap.get(String(key).toLowerCase());
        if (!actualKey) continue;

        const value = source[actualKey];
        if (typeof value === 'string' && value.trim()) return value.trim();
        if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    }
    return "";
}

function parseJsonObject(text) {
    if (typeof text !== 'string' || text.trim() === '') return null;
    try {
        const parsed = JSON.parse(text);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch (e) {
        return null;
    }
}

function splitPromptSections(text) {
    let positive = text;
    let negative = "";

    const negMatch = positive.match(/\n?Negative prompt:\s*/i);
    if (negMatch) {
        negative = positive.slice(negMatch.index + negMatch[0].length).trim();
        positive = positive.slice(0, negMatch.index).trim();
    }

    const stepMatch = positive.match(/\n?Steps:\s*/i);
    if (stepMatch) positive = positive.slice(0, stepMatch.index).trim();

    const negativeStepMatch = negative.match(/\n?Steps:\s*/i);
    if (negativeStepMatch) negative = negative.slice(0, negativeStepMatch.index).trim();

    return { positive, negative };
}

function collectParams(data, parsed) {
    const params = {};
    const sources = [data, parsed].filter(Boolean);
    const keyMap = {
        Seed: ['seed'],
        Steps: ['steps'],
        Sampler: ['sampler', 'sampler_name'],
        Scheduler: ['scheduler'],
        CFG: ['cfg', 'cfg_scale', 'scale'],
        Guidance: ['guidance', 'guidance_scale'],
        Model: ['model', 'model_name'],
        Size: ['size', 'resolution']
    };

    for (const [label, keys] of Object.entries(keyMap)) {
        for (const source of sources) {
            const value = getFirstMetadataValue(source, keys);
            if (value) {
                params[label] = value;
                break;
            }
        }
    }

    return params;
}

function recursiveFindText(flow, input) {
    if (!input) return "";
    const id = Array.isArray(input) ? String(input[0]) : String(input);
    const node = flow[id];
    if (!node) return "";

    if (node.inputs) {
        if (typeof node.inputs.text === 'string') return node.inputs.text;
        if (typeof node.inputs.prompt === 'string') return node.inputs.prompt;
        
        // Follow conditioning
        if (node.inputs.conditioning) return recursiveFindText(flow, node.inputs.conditioning);
        if (node.inputs.conditioning_1) return recursiveFindText(flow, node.inputs.conditioning_1);
        if (node.inputs.conditioning_2) return recursiveFindText(flow, node.inputs.conditioning_2);
        if (node.inputs.base_conditioning) return recursiveFindText(flow, node.inputs.base_conditioning);
        if (node.inputs.positive) return recursiveFindText(flow, node.inputs.positive);
        if (node.inputs.negative) return recursiveFindText(flow, node.inputs.negative);
    }
    return "";
}

function parseA1111Params(str) {
    const p = {};
    str.split(', ').forEach(pair => {
        const c = pair.indexOf(': ');
        if (c !== -1) p[pair.substring(0, c).trim()] = pair.substring(c + 2).trim();
    });
    return p;
}

function copyText(id, btn) {
    const text = document.getElementById(id).innerText;
    if (text.startsWith("(")) return; // Skip "No prompt detected"
    navigator.clipboard.writeText(text).then(() => {
        const originalText = btn.innerText;
        btn.innerText = 'Copied!';
        btn.classList.add('copied');
        setTimeout(() => {
            btn.innerText = originalText;
            btn.classList.remove('copied');
        }, 2000);
    });
}

