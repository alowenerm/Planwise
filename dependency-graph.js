/**
 * dependency-graph.js
 * 
 * Módulo para renderizar el gráfico de dependencias utilizando Mermaid.js.
 */

async function renderDependencyGraph(tasks) {
    if (typeof mermaid === 'undefined') {
        console.error("Mermaid.js no está cargado.");
        return;
    }

    const container = document.getElementById('dependency-graph-container');
    if (!container) return;
    container.innerHTML = '<p class="text-muted p-3">Generando gráfico...</p>';

    if (!tasks || tasks.length === 0) {
        container.innerHTML = '<p class="text-muted p-3">No hay tareas para mostrar en el gráfico.</p>';
        return;
    }

    let mermaidDefinition = 'graph TD;\n';
    
    const sanitizedIdMap = new Map();
    tasks.forEach(task => {
        // Usamos un prefijo para asegurar que el ID es válido y único
        const sanitizedId = `task_${task.id.replace(/[^a-zA-Z0-9_]/g, '')}`;
        sanitizedIdMap.set(task.id, sanitizedId);
    });

    tasks.forEach(task => {
        const sanitizedId = sanitizedIdMap.get(task.id);
        const taskName = task.name.replace(/"/g, '#quot;');
        
        mermaidDefinition += `    ${sanitizedId}("${taskName}");\n`;

        if (task.dependencies && task.dependencies.length > 0) {
            task.dependencies.forEach(dep => {
                const predecessorSanitizedId = sanitizedIdMap.get(dep.id);
                if (predecessorSanitizedId) {
                    mermaidDefinition += `    ${predecessorSanitizedId} --> ${sanitizedId};\n`;
                }
            });
        }
    });

    try {
        // Usamos async/await para manejar la promesa de mermaid.render.
        // Esto captura correctamente los errores de renderizado asíncronos.
        const { svg } = await mermaid.render('mermaid-svg-graph', mermaidDefinition);
        container.innerHTML = svg;

        // Ahora que el SVG está en el DOM, añadimos los data-attributes y listeners.
        const svgNodes = container.querySelectorAll('.node');
        
        // Creamos un mapa inverso para buscar el ID original a partir del sanitizado.
        const reverseSanitizedIdMap = new Map(Array.from(sanitizedIdMap, a => [a[1], a[0]]));

        svgNodes.forEach(node => {
            // El ID del nodo es generado por Mermaid, ej: "flowchart-task_123abc-1".
            // Extraemos nuestro ID sanitizado de él.
            const sanitizedId = node.id.substring(node.id.indexOf('-') + 1);
            const originalTaskId = reverseSanitizedIdMap.get(sanitizedId);

            if (originalTaskId) {
                node.setAttribute('data-task-id', originalTaskId);
                node.style.cursor = 'pointer';
                // El listener de click se añade aquí, llamando a la función global.
                node.addEventListener('click', handleNodeClick);
            }
        });

    } catch (e) {
        // El bloque catch ahora sí captura el error de la promesa.
        container.innerHTML = `<div class="alert alert-danger">Error al generar el gráfico. Es posible que exista una dependencia circular o un problema de renderizado. Detalles: ${e.message}</div>`;
        console.error("Error renderizando el gráfico de Mermaid:", e);
    }
}

// El handler que será llamado por Mermaid
function handleNodeClick(event) {
    const nodeElement = event.target.closest('.node');
    if (nodeElement && nodeElement.dataset.taskId) {
        const taskId = nodeElement.dataset.taskId;
        // La función openTaskDetailTab debe estar definida globalmente o en el scope de la ventana
        if (window.openTaskDetailTab) {
            window.openTaskDetailTab(taskId);
        } else {
            console.error("La función openTaskDetailTab no está disponible globalmente.");
        }
    }
}