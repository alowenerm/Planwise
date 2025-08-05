/**
 * gantt-calculator.js
 * 
 * Contiene la lógica pura para calcular las fechas de inicio y fin de las tareas
 * basándose en sus dependencias. No interactúa con el DOM.
 */

/**
 * Formatea un objeto Date a una cadena 'YYYY-MM-DD'.
 * @param {Date} date - El objeto Date a formatear.
 * @returns {string} La fecha formateada o una cadena vacía si la fecha es inválida.
 */
function _formatDate(date) {
    if (!date || isNaN(date.getTime())) {
        return '';
    }
    return date.toISOString().split('T')[0];
}

/**
 * Encuentra la fecha máxima de un array de cadenas de fecha.
 * @param {string[]} dateStrings - Un array de fechas en formato 'YYYY-MM-DD'.
 * @returns {Date|null} El objeto Date máximo o null si no hay fechas válidas.
 */
function _getMaxDate(dateStrings) {
    const validDates = dateStrings
        .filter(ds => ds) // Filtrar cadenas vacías o nulas
        .map(ds => new Date(ds)); // Convertir a objetos Date

    if (validDates.length === 0) {
        return null;
    }

    return new Date(Math.max.apply(null, validDates));
}

/**
 * Función principal que calcula las fechas para una lista de tareas.
 * Itera múltiples veces para asegurar que las dependencias en cadena se resuelvan.
 * @param {Array<Object>} tasks - El array de objetos de tarea.
 * @returns {Array<Object>} Un nuevo array de tareas con las fechas calculadas y flags de estado.
 */
function calculateTaskDates(tasks) {
    let calculatedTasks = JSON.parse(JSON.stringify(tasks));
    const taskMap = new Map(calculatedTasks.map(t => [t.id, t]));

    let datesChanged;
    let iterations = 0;
    const maxIterations = calculatedTasks.length + 1;

    do {
        datesChanged = false;
        iterations++;

        calculatedTasks.forEach(task => {
            const hasStartDependencies = task.dependencies.some(d => d.type === 'Fin-Inicio (FI)' || d.type === 'Inicio-Inicio (II)');
            const hasEndDependencies = task.dependencies.some(d => d.type === 'Fin-Fin (FF)' || d.type === 'Inicio-Fin (IF)');

            task.startDateIsCalculated = hasStartDependencies;
            task.endDateIsCalculated = hasEndDependencies;

            let newStartDate = task.startDate;
            let newEndDate = task.endDate;

            if (task.startDateIsCalculated) {
                const relevantDates = task.dependencies
                    .map(dep => {
                        const predecessor = taskMap.get(dep.id);
                        if (!predecessor) return null;
                        if (dep.type === 'Fin-Inicio (FI)') return predecessor.endDate;
                        if (dep.type === 'Inicio-Inicio (II)') return predecessor.startDate;
                        return null;
                    })
                    .filter(date => date);

                const maxDate = _getMaxDate(relevantDates);
                if (maxDate) {
                    newStartDate = _formatDate(maxDate);
                }
            }

            if (task.endDateIsCalculated) {
                const relevantDates = task.dependencies
                    .map(dep => {
                        const predecessor = taskMap.get(dep.id);
                        if (!predecessor) return null;
                        if (dep.type === 'Fin-Fin (FF)') return predecessor.endDate;
                        if (dep.type === 'Inicio-Fin (IF)') return predecessor.startDate;
                        return null;
                    })
                    .filter(date => date);

                const maxDate = _getMaxDate(relevantDates);
                if (maxDate) {
                    newEndDate = _formatDate(maxDate);
                }
            }

            if (task.startDate !== newStartDate || task.endDate !== newEndDate) {
                datesChanged = true;
                task.startDate = newStartDate;
                task.endDate = newEndDate;
            }
        });

    } while (datesChanged && iterations < maxIterations);
    
    if (iterations >= maxIterations) {
        console.warn("Cálculo de Gantt detenido: posible dependencia circular detectada.");
        return {
            tasks: calculatedTasks,
            error: "Se ha detectado una dependencia circular. Por favor, revisa las predecesoras de tus tareas."
        };
    }

    return { tasks: calculatedTasks, error: null };
}