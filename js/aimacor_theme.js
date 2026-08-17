import { app } from "../../scripts/app.js";

// ============================================================
// Aimacor Labs — Tema cyberpunk aplicado a nivel de canvas
// (color de barra de título, cuerpo del nodo y acento del
// indicador). Se aplica automáticamente a CUALQUIER nodo cuya
// categoría empiece con "Aimacor Labs", sin necesidad de tocar
// cada archivo de nodo individualmente.
// ============================================================

const AIMACOR_TITLE_COLOR = "#4b2e83";   // violeta profundo — barra de título
const AIMACOR_BODY_COLOR = "#0d0221";    // casi negro con tinte violeta — cuerpo del nodo
const AIMACOR_ACCENT_COLOR = "#8a2be2";  // blueviolet — acento del indicador

app.registerExtension({
    name: "AimacorLabs.Theme",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        const category = nodeData.category || "";
        if (category === "Aimacor Labs" || category.startsWith("Aimacor Labs/")) {
            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                if (onNodeCreated) onNodeCreated.apply(this, arguments);
                this.color = AIMACOR_TITLE_COLOR;
                this.bgcolor = AIMACOR_BODY_COLOR;
                this.boxcolor = AIMACOR_ACCENT_COLOR;
            };
        }
    }
});
