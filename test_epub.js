const fs = require('fs');
const JSZip = require('jszip');
const DOMParser = require('xmldom').DOMParser;

async function checkEpub() {
    const epubPath = "C:\\Users\\admin\\Desktop\\BookShelf\\Lite Novel\\จอมเวทผู้มองเห็นทุกสิ่ง คุนอน\\จอมเวทผู้มองเห็นทุกสิ่ง คุนอน เล่ม 6 (ฉบับนิยาย).epub";
    const data = fs.readFileSync(epubPath);
    const zip = await JSZip.loadAsync(data);
    
    console.log("=== Files in ZIP ===");
    const filePaths = Object.keys(zip.files);
    filePaths.filter(f => f.includes('image') || f.includes('.jpg') || f.includes('.png')).forEach(f => {
        console.log(f);
    });
    
    console.log("\n=== Checking an HTML file ===");
    // Find an html file
    const htmlFile = filePaths.find(f => f.endsWith('.xhtml') || f.endsWith('.html'));
    if (htmlFile) {
        console.log("HTML file found:", htmlFile);
        const htmlContent = await zip.file(htmlFile).async("string");
        const doc = new DOMParser().parseFromString(htmlContent, "text/xml");
        const images = doc.getElementsByTagName("image");
        for (let i = 0; i < images.length; i++) {
            console.log("SVG <image> href:", images[i].getAttribute("href") || images[i].getAttribute("xlink:href"));
        }
        const imgs = doc.getElementsByTagName("img");
        for (let i = 0; i < imgs.length; i++) {
            console.log("HTML <img> src:", imgs[i].getAttribute("src"));
        }
    }
}

checkEpub().catch(console.error);
