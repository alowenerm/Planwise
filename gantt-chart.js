/**
 * gantt-chart.js
 * 
 * Módulo para renderizar el gráfico de Gantt interactivo utilizando Frappe Gantt.
 * Maneja múltiples vistas (Día, Semana, Mes, Trimestre, Año) con anchos de columna dinámicos.
 */

let ganttChartInstance = null;
let currentFrappeTasks = []; // Almacena los datos transformados para no reprocesarlos innecesariamente.

// Mapa de configuraciones para cada modo de vista.
const viewModeConfigs = {
    'Day': { view_mode: 'Day', column_width: 35 },
    'Week': { view_mode: 'Week', column_width: 35 },
    'Month': { view_mode: 'Month', column_width: 30 },
    'Quarter': { view_mode: 'Month', column_width: 20 }, // Simula Trimestre con vista de Mes comprimida
    'Year': { view_mode: 'Month', column_width: 15 }    // Simula Año con vista de Mes muy comprimida
};

// CORRECCIÓN: Mover modeLabels al ámbito del módulo para que sea accesible por ambas funciones.
const modeLabels = { 'Day': 'Día', 'Week': 'Semana', 'Month': 'Mes', 'Quarter': 'Trimestre', 'Year': 'Año' };

/**
 * Dibuja el gráfico de Gantt con una configuración específica para el modo de vista.
 * @param {string} mode - El modo de vista a renderizar ('Day', 'Week', 'Month', etc.).
 */
function drawGanttWithViewMode(mode) {
    const container = document.getElementById('gantt-chart-container');
    if (!container) return;
    container.innerHTML = '';

    if (currentFrappeTasks.length === 0) {
        container.innerHTML = '<p class="text-muted p-3">No hay tareas con fechas para mostrar en el gráfico.</p>';
        setupViewModeButtons(mode); // Dibujar los botones incluso si no hay tareas
        return;
    }

    const config = viewModeConfigs[mode];

    ganttChartInstance = new Gantt("#gantt-chart-container", currentFrappeTasks, {
        header_height: 50,
        column_width: config.column_width,
        step: 24,
        view_mode: config.view_mode,
        bar_height: 20,
        bar_corner_radius: 3,
        arrow_curve: 5,
        padding: 18,
        date_format: 'YYYY-MM-DD',
        language: 'es',
        on_click: (task) => console.log("Tarea clickeada: ", task),
        on_date_change: (task, start, end) => {
            const tasksTbody = document.getElementById('tasks-tbody');
            const taskRow = tasksTbody.querySelector(`tr[data-task-id="${task.id}"]`);
            if (!taskRow) return;

            const startDateInput = taskRow.querySelector('[name="taskStartDate"]');
            const endDateInput = taskRow.querySelector('[name="taskEndDate"]');

            if (startDateInput.readOnly || endDateInput.readOnly) {
                alert("No se pueden modificar las fechas de esta tarea porque son calculadas por sus dependencias.");
                runGanttCalculationAndUpdateUI();
                return;
            }

            const inclusiveEndDate = new Date(end.getTime() - (1000 * 60 * 60 * 24));
            if (start > inclusiveEndDate) {
                alert("La fecha de inicio no puede ser posterior a la fecha de fin.");
                runGanttCalculationAndUpdateUI();
                return;
            }

            startDateInput.value = start.toISOString().split('T')[0];
            endDateInput.value = inclusiveEndDate.toISOString().split('T')[0];

            runGanttCalculationAndUpdateUI();
            debouncedSaveToFirestore();
        }
    });

    setupViewModeButtons(mode);
}

/**
 * Crea y gestiona los botones para cambiar la vista del gráfico.
 * @param {string} activeMode - El modo de vista que debe aparecer como activo.
 */
function setupViewModeButtons(activeMode) {
    const container = document.getElementById('gantt-view-mode-buttons');
    if (!container) return;
    container.innerHTML = '';

    const modes = ['Day', 'Week', 'Month', 'Quarter', 'Year'];

    modes.forEach(mode => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn btn-outline-secondary';
        button.textContent = modeLabels[mode];
        
        if (mode === activeMode) {
            button.classList.add('active');
        }

        button.addEventListener('click', () => {
            drawGanttWithViewMode(mode);
        });
        container.appendChild(button);
    });
}

/**
 * Función principal que transforma los datos y lanza el primer renderizado del gráfico.
 * @param {Array<Object>} tasks - El array de objetos de tarea originales.
 */
function renderGanttChart(tasks) {
    currentFrappeTasks = tasks
        .filter(task => task.startDate && task.endDate)
        .map(task => {
            const dependencyIds = task.dependencies.map(dep => dep.id).join(',');
            const start = new Date(task.startDate);
            const end = new Date(task.endDate);
            const duration = Math.round((end - start) / (1000 * 60 * 60 * 24)) + 1;
            const taskLabel = `${task.name} (${duration} días)`;

            return {
                id: task.id,
                name: taskLabel,
                start: task.startDate,
                end: task.endDate,
                progress: task.status === 'Completada' ? 100 : 0,
                dependencies: dependencyIds,
                custom_class: task.status === 'Completada' ? 'task-completed' : 'task-pending'
            };
        });

    const activeBtn = document.querySelector('#gantt-view-mode-buttons .btn.active');
    const currentView = activeBtn ? activeBtn.textContent : 'Semana';
    const viewModeKey = Object.keys(modeLabels).find(key => modeLabels[key] === currentView) || 'Week';

    drawGanttWithViewMode(viewModeKey);
}