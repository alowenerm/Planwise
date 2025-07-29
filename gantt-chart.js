/**
 * gantt-chart.js
 * 
 * Módulo para renderizar el gráfico de Gantt interactivo utilizando Frappe Gantt.
 */

// Variable global para mantener la instancia del gráfico.
let ganttChartInstance = null;

/**
 * Renderiza o actualiza el gráfico de Gantt.
 * @param {Array<Object>} tasks - El array de objetos de tarea con fechas calculadas.
 */
function renderGanttChart(tasks) {
    const container = document.getElementById('gantt-chart-container');
    if (!container) return;

    // Frappe Gantt no tiene un método destroy(), así que simplemente vaciamos el contenedor.
    container.innerHTML = '';

    // 1. Transformar los datos al formato que necesita Frappe Gantt.
    const frappeTasks = tasks
        .filter(task => task.startDate && task.endDate) // Solo incluir tareas con ambas fechas
        .map(task => {
            // Convertir el array de objetos de dependencia a una cadena de IDs.
            const dependencyIds = task.dependencies.map(dep => dep.id).join(',');

            return {
                id: task.id,
                name: task.name,
                start: task.startDate,
                end: task.endDate,
                progress: task.status === 'Completada' ? 100 : 0,
                dependencies: dependencyIds,
                // Asignamos una clase CSS personalizada para el estilo condicional.
                custom_class: task.status === 'Completada' ? 'task-completed' : 'task-pending'
            };
        });

    // Si no hay tareas con fechas, mostrar un mensaje.
    if (frappeTasks.length === 0) {
        container.innerHTML = '<p class="text-muted p-3">No hay tareas con fechas para mostrar en el gráfico.</p>';
        return;
    }

    // 2. Configurar e instanciar el gráfico.
    ganttChartInstance = new Gantt("#gantt-chart-container", frappeTasks, {
        header_height: 50,
        column_width: 30,
        step: 24,
        view_modes: ['Day', 'Week', 'Month'],
        bar_height: 20,
        bar_corner_radius: 3,
        arrow_curve: 5,
        padding: 18,
        view_mode: 'Week', // Vista por defecto
        date_format: 'YYYY-MM-DD',
        language: 'es', // Para que los meses salgan en español
        on_click: function (task) {
            console.log("Tarea clickeada: ", task);
            // Aquí se podría añadir lógica futura, como abrir un modal de edición.
        }
    });
}