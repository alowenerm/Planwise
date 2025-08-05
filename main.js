document.addEventListener('DOMContentLoaded', function() {
    
    // --- VARIABLES GLOBALES ---
    let currentUserId = null;
    let currentTaskListId = null;
    let currentUserRole = null;
    let unsubscribeTaskList = null;
    let unsubscribeMembers = null;
    let unsubscribeUserLists = null;
    let lastKnownServerState = null;
    let isReadOnlyMode = false;
    let dependencyModalInstance = null;
    let currentEditingTaskId = null;
    
    let allTasksCache = [];
    let taskViewStack = [];
    let isExpandedView = false;

    const debounce = (func, delay) => {
        let timeoutId;
        return function(...args) {
            clearTimeout(timeoutId);
            timeoutId = setTimeout(() => {
                func.apply(this, args);
            }, delay);
        };
    };

    // --- SELECTORES DE ELEMENTOS ---
    const authContainer = document.getElementById('auth-container');
    const appContainer = document.getElementById('app-container');
    const loginForm = document.getElementById('login-form');
    const authErrorEl = document.getElementById('auth-error');
    const tasksTbody = document.getElementById('tasks-tbody');
    
    const tooltipTriggerList = document.querySelectorAll('[data-bs-toggle="tooltip"]');
    [...tooltipTriggerList].map(tooltipTriggerEl => new bootstrap.Tooltip(tooltipTriggerEl));

    // --- FUNCIONES DE AUTENTICACIÓN (Sin cambios) ---
    const showAuthMessage = (message, type = 'danger') => {
        authErrorEl.textContent = message;
        authErrorEl.className = `alert alert-${type}`;
        authErrorEl.style.display = 'block';
    };
    const clearAuthError = () => { authErrorEl.style.display = 'none'; };
    const handleLogin = (e) => { e.preventDefault(); clearAuthError(); auth.signInWithEmailAndPassword(loginForm.email.value, loginForm.password.value).catch(error => showAuthMessage("Correo o contraseña incorrectos.")); };
    const handleSignUp = () => { clearAuthError(); if (loginForm.password.value.length < 6) { showAuthMessage("La contraseña debe tener al menos 6 caracteres."); return; } auth.createUserWithEmailAndPassword(loginForm.email.value, loginForm.password.value).catch(error => showAuthMessage(error.code === 'auth/email-already-in-use' ? "Este correo ya está registrado." : "Error: " + error.message)); };
    const handleGoogleSignIn = () => { clearAuthError(); auth.signInWithPopup(new firebase.auth.GoogleAuthProvider()).catch(err => showAuthMessage("Error con Google: " + err.message)); };
    const handleForgotPassword = (e) => { e.preventDefault(); clearAuthError(); if (!loginForm.email.value) { showAuthMessage("Ingresa tu correo."); return; } auth.sendPasswordResetEmail(loginForm.email.value).then(() => showAuthMessage("Correo de recuperación enviado.", "success")).catch(() => showAuthMessage("Error al enviar el correo.")); };
    
    const handleLogout = () => {
        if (unsubscribeTaskList) unsubscribeTaskList();
        if (unsubscribeMembers) unsubscribeMembers();
        if (unsubscribeUserLists) unsubscribeUserLists();
        history.pushState(null, '', window.location.pathname);
        auth.signOut();
    };

    // --- OBSERVADOR DE AUTENTICACIÓN ---
    auth.onAuthStateChanged(user => {
        if (user) { handleUserLogin(user); } 
        else {
            currentUserId = null;
            currentTaskListId = null;
            currentUserRole = null;
            authContainer.style.display = 'flex';
            appContainer.style.display = 'none';
            loginForm.reset();
        }
    });

    // --- GESTIÓN DE USUARIOS ---
    function handleUserLogin(user) {
        const userDocRef = db.collection('users').doc(user.uid);
        userDocRef.get().then(doc => {
            if (!doc.exists) {
                const registrationDate = new Date();
                const newUserInfo = {
                    email: user.email,
                    registrationDate: firebase.firestore.Timestamp.fromDate(registrationDate),
                    authProvider: user.providerData[0].providerId
                };
                userDocRef.set(newUserInfo).then(() => proceedToApp(user));
            } else {
                proceedToApp(user);
            }
        });
    }

    function proceedToApp(user) {
        currentUserId = user.uid;
        document.getElementById('sidebar-user-info').textContent = user.email;
        authContainer.style.display = 'none';
        appContainer.style.display = 'flex';
        initializeAppLogic();
        initShareFunctionality();
        initTaskListsModal();
    }

    // --- LÓGICA DE LA APLICACIÓN ---
    async function initializeAppLogic() {
        document.getElementById('new-task-list-btn').addEventListener('click', () => loadNewTaskListState(true));
        const taskListNameInput = document.getElementById('taskListName');
        taskListNameInput.addEventListener('input', debouncedSaveToFirestore);
        
        tasksTbody.addEventListener('change', (e) => {
            const target = e.target;
            const row = target.closest('tr');
            if (!row) return;

            if (target.matches('input[type="date"]') && !target.readOnly) {
                validateAndCorrectDates(row);
                runGanttCalculationAndUpdateUI();
            } else if (target.matches('select[name="taskStatus"]')) {
                runGanttCalculationAndUpdateUI();
            }
            
            debouncedSaveToFirestore();
        });

        tasksTbody.addEventListener('click', (e) => {
            const subtaskBtn = e.target.closest('.subtask-count-btn');
            const predBtn = e.target.closest('.dependency-cell button');

            if (isExpandedView) {
                const targetBtn = subtaskBtn || predBtn;
                if (targetBtn && !targetBtn.disabled) {
                    if (predBtn) e.preventDefault();
                    
                    isExpandedView = false;
                    navigateToSubtasks(targetBtn.dataset.taskId);
                }
            } else {
                if (subtaskBtn && !subtaskBtn.disabled) {
                    navigateToSubtasks(subtaskBtn.dataset.taskId);
                }
            }
        });

        const breadcrumbEl = document.getElementById('breadcrumb-title');
        if (breadcrumbEl) {
            breadcrumbEl.addEventListener('click', () => {
                if (taskViewStack.length > 0) {
                    navigateUp();
                }
            });
        }

        const toggleExpandBtn = document.getElementById('toggle-expand-btn');
        if (toggleExpandBtn) {
            toggleExpandBtn.addEventListener('click', () => {
                isExpandedView = !isExpandedView;
                bootstrap.Tooltip.getInstance(toggleExpandBtn)?.hide();
                updateTaskView();
            });
        }

        const ganttTabBtn = document.getElementById('gantt-tab-btn');
        if (ganttTabBtn) {
            ganttTabBtn.addEventListener('shown.bs.tab', () => {
                renderGanttChart(allTasksCache);
            });
        }

        document.getElementById('add-task').addEventListener('click', () => { 
            addTaskRow(); 
            runGanttCalculationAndUpdateUI();
            debouncedSaveToFirestore(); 
        });

        const sidebarToggle = document.getElementById('sidebar-toggle');
        sidebarToggle.addEventListener('click', () => { document.body.classList.toggle('sidebar-collapsed'); sidebarToggle.querySelector('i').className = document.body.classList.contains('sidebar-collapsed') ? 'bi bi-chevron-right' : 'bi-chevron-left'; });
        sidebarToggle.querySelector('i').className = document.body.classList.contains('sidebar-collapsed') ? 'bi bi-chevron-right' : 'bi-chevron-left';
        initSortable(tasksTbody);
        initDependencyModal();

        const initialTaskListId = getTaskListIdFromUrl();
        if (initialTaskListId) { await listenToTaskList(initialTaskListId); } 
        else { loadNewTaskListState(false); }
    }
  
    async function loadNewTaskListState(confirmFirst = false) {
        if (confirmFirst && !confirm("¿Crear una nueva lista de tareas?")) return;
        if (unsubscribeTaskList) unsubscribeTaskList();
        if (unsubscribeMembers) unsubscribeMembers();
        currentTaskListId = null;
        currentUserRole = 'owner';
        lastKnownServerState = null;
        isExpandedView = false;
        if (window.location.search !== "") history.pushState(null, '', window.location.pathname);
        setReadOnly(false);
        document.getElementById('share-task-list-btn').style.display = 'none';
        
        try {
            const response = await fetch('default-task-list.json');
            const data = await response.json();
            loadTasksFromJSON(data);
        } catch (e) {
            loadTasksFromJSON({ taskListName: 'Nueva Lista de Tareas', tasks: [] });
        }
        
        saveTaskListToFirestore();
    }    

    // --- FUNCIONES DE DATOS (FIRESTORE) ---
    async function saveTaskListToFirestore() {
        if (!currentUserId || isReadOnlyMode) return;
        const data = getTasksData();
        const taskListDataToSave = {
            ...data,
            lastUpdated: firebase.firestore.FieldValue.serverTimestamp(),
        };

        lastKnownServerState = JSON.stringify(taskListDataToSave);

        if (!currentTaskListId) {
            updateSaveStatus('Creando lista...');
            try {
                const newDocRef = await db.collection('tareas').add({
                    ...taskListDataToSave,
                    ownerId: currentUserId,
                    creationDate: firebase.firestore.FieldValue.serverTimestamp()
                });
                
                currentTaskListId = newDocRef.id;

                await db.collection('tareas').doc(currentTaskListId).collection('members').doc(currentUserId).set({
                    email: auth.currentUser.email,
                    role: 'owner'
                });

                 await db.collection('user_task_lists').doc(currentUserId).collection('lists').doc(currentTaskListId).set({
                    name: data.taskListName,
                    role: 'owner'
                });

                const newUrl = `${window.location.pathname}?id=${currentTaskListId}`;
                history.pushState({ path: newUrl }, '', newUrl);
                await listenToTaskList(currentTaskListId);
                updateSaveStatus('Guardado');
            } catch (error) {
                console.error("Error creando lista:", error);
                updateSaveStatus('Error al crear', true);
            }
        } else {
            updateSaveStatus('Guardando...');
            try {
                const batch = db.batch();
                const taskListRef = db.collection('tareas').doc(currentTaskListId);
                batch.update(taskListRef, taskListDataToSave);

                const membersSnapshot = await db.collection('tareas').doc(currentTaskListId).collection('members').get();
                membersSnapshot.forEach(memberDoc => {
                    const userListRef = db.collection('user_task_lists').doc(memberDoc.id).collection('lists').doc(currentTaskListId);
                    batch.update(userListRef, { name: data.taskListName });
                });

                await batch.commit();
                updateSaveStatus('Guardado');
            } catch (error) {
                console.error("Error guardando:", error);
                updateSaveStatus('Error al guardar', true);
            }
        }
    }
    
    const debouncedSaveToFirestore = debounce(saveTaskListToFirestore, 1500);

    function getTaskListIdFromUrl() {
        return new URLSearchParams(window.location.search).get('id');
    }

    async function listenToTaskList(taskListId) {
        if (!currentUserId) return;
        if (unsubscribeTaskList) unsubscribeTaskList();

        currentTaskListId = taskListId;
        
        const memberDoc = await db.collection('tareas').doc(taskListId).collection('members').doc(currentUserId).get();
        
        if (!memberDoc.exists) {
            alert("No tienes acceso a esta lista.");
            loadNewTaskListState(false);
            return;
        }
        currentUserRole = memberDoc.data().role;
        isReadOnlyMode = (currentUserRole === 'viewer');
        setReadOnly(isReadOnlyMode);
        
        const shareBtn = document.getElementById('share-task-list-btn');
        shareBtn.style.display = 'block';
        shareBtn.disabled = (currentUserRole !== 'owner');

        updateSaveStatus('Cargando lista...');
        unsubscribeTaskList = db.collection('tareas').doc(taskListId).onSnapshot((doc) => {
            if (!doc.exists) {
                alert("La lista ya no existe o no tienes acceso.");
                if (unsubscribeTaskList) unsubscribeTaskList();
                loadNewTaskListState(false);
                return;
            }

            if (doc.metadata.hasPendingWrites) {
                return;
            }

            console.log("Remote change detected, refreshing data...");
            const serverData = doc.data();
            document.getElementById('taskListName').value = serverData.taskListName || 'Nueva Lista';
            allTasksCache = serverData.tasks || [];
            
            runGanttCalculationAndUpdateUI();
            updateSaveStatus('Lista actualizada');

        }, error => {
            console.error("Error escuchando la lista:", error);
            updateSaveStatus('Error de conexión', true);
        });
    }

    // --- FUNCIONES PARA COMPARTIR (FIRESTORE) ---
    let shareModalInstance = null;

    function initShareFunctionality() {
        if (!shareModalInstance) shareModalInstance = new bootstrap.Modal(document.getElementById('shareModal'));
        document.getElementById('share-task-list-btn').addEventListener('click', openShareModal);
        document.getElementById('add-user-btn').addEventListener('click', addUserToList);
        document.getElementById('user-access-list').addEventListener('click', (e) => { if (e.target.closest('.remove-user-btn')) removeUserFromList(e.target.closest('.remove-user-btn').dataset.uid); });
        document.getElementById('user-access-list').addEventListener('change', (e) => { if (e.target.matches('.role-select')) updateUserRole(e.target.dataset.uid, e.target.value); });
    }

    function openShareModal() {
        if (!currentTaskListId) return;
        document.getElementById('share-error').style.display = 'none';
        document.getElementById('share-email-input').value = '';
        if (unsubscribeMembers) unsubscribeMembers();
        
        unsubscribeMembers = db.collection('tareas').doc(currentTaskListId).collection('members').onSnapshot(snapshot => {
            const members = {};
            snapshot.forEach(doc => { members[doc.id] = doc.data(); });
            renderUserList(members);
        });
        shareModalInstance.show();
    }

    function renderUserList(members) {
        const userListEl = document.getElementById('user-access-list');
        userListEl.innerHTML = '';
        if (!members) return;
        const isOwner = members[currentUserId]?.role === 'owner';
        Object.entries(members).forEach(([uid, userData]) => {
            const li = document.createElement('li');
            li.className = 'list-group-item d-flex justify-content-between align-items-center';
            const isCurrentUserOwner = (uid === currentUserId && userData.role === 'owner');
            const roleDisplay = isCurrentUserOwner ? `<span class="badge bg-success rounded-pill">Propietario</span>` : `<select class="form-select form-select-sm role-select" data-uid="${uid}" ${!isOwner ? 'disabled' : ''}><option value="editor" ${userData.role === 'editor' ? 'selected' : ''}>Editor</option><option value="viewer" ${userData.role === 'viewer' ? 'selected' : ''}>Solo Lectura</option></select>`;
            const actionBtn = (isOwner && uid !== currentUserId) ? `<button class="btn btn-sm btn-outline-danger remove-user-btn" data-uid="${uid}"><i class="bi bi-trash"></i></button>` : '';
            li.innerHTML = `<div>${userData.email || '...'}</div><div class="d-flex align-items-center gap-2"><div class="role-select-cell">${roleDisplay}</div><div class="action-btn-cell">${actionBtn}</div></div>`;
            userListEl.appendChild(li);
        });
    }

    async function updateUserRole(uid, newRole) {
        if (!currentTaskListId) return;
        const batch = db.batch();
        batch.update(db.collection('tareas').doc(currentTaskListId).collection('members').doc(uid), { role: newRole });
        batch.update(db.collection('user_task_lists').doc(uid).collection('lists').doc(currentTaskListId), { role: newRole });
        await batch.commit();
    }

    async function addUserToList() {
        const email = document.getElementById('share-email-input').value.trim();
        const errorEl = document.getElementById('share-error');
        errorEl.style.display = 'none';
        if (!email) { errorEl.textContent = 'Introduce un correo.'; errorEl.style.display = 'block'; return; }
        
        try {
            const userQuery = await db.collection('users').where('email', '==', email).limit(1).get();
            if (userQuery.empty) { throw new Error('Usuario no encontrado.'); }
            const targetUserDoc = userQuery.docs[0];
            const targetUid = targetUserDoc.id;

            const role = document.getElementById('share-role-select').value;
            const taskListData = getTasksData();
            
            const batch = db.batch();
            batch.set(db.collection('tareas').doc(currentTaskListId).collection('members').doc(targetUid), { email: email, role: role });
            batch.set(db.collection('user_task_lists').doc(targetUid).collection('lists').doc(currentTaskListId), { name: taskListData.taskListName, role: role });
            await batch.commit();

            document.getElementById('share-email-input').value = '';
        } catch (error) {
            errorEl.textContent = 'Error: ' + error.message;
            errorEl.style.display = 'block';
        }
    }

    async function removeUserFromList(uidToRemove) {
        if (!confirm("¿Quitar acceso a este usuario?")) return;
        const batch = db.batch();
        batch.delete(db.collection('tareas').doc(currentTaskListId).collection('members').doc(uidToRemove));
        batch.delete(db.collection('user_task_lists').doc(uidToRemove).collection('lists').doc(currentTaskListId));
        await batch.commit();
    }

    // --- LISTAR Y ABRIR LISTAS (FIRESTORE) ---
    let taskListsModalInstance = null;

    function initTaskListsModal() {
        if (!taskListsModalInstance) taskListsModalInstance = new bootstrap.Modal(document.getElementById('taskListsModal'));
        document.getElementById('open-task-lists-btn').addEventListener('click', () => taskListsModalInstance.show());
        if (unsubscribeUserLists) unsubscribeUserLists();
        
        unsubscribeUserLists = db.collection('user_task_lists').doc(currentUserId).collection('lists').orderBy('name').onSnapshot(snapshot => {
            const lists = {};
            snapshot.forEach(doc => { lists[doc.id] = doc.data(); });
            renderTaskLists(lists);
        });

        document.getElementById('task-list-container').addEventListener('click', e => {
            const deleteBtn = e.target.closest('.delete-task-list-btn');
            if (deleteBtn) { e.stopPropagation(); deleteTaskList(deleteBtn.dataset.id, deleteBtn.dataset.name); } 
            else { const row = e.target.closest('.task-list-row'); if (row) window.location.href = row.dataset.href; }
        });
    }

    function renderTaskLists(lists) {
        const container = document.getElementById('task-list-container');
        if (Object.keys(lists).length === 0) { container.innerHTML = '<p class="text-muted text-center mt-3">No tienes listas.</p>'; return; }
        const tableRowsHtml = Object.entries(lists).map(([id, data]) => `
            <tr class="task-list-row align-middle" data-href="${window.location.pathname}?id=${id}">
                <td>${data.name || '...'}</td>
                <td><span class="badge bg-light text-dark border rounded-pill">${data.role || '...'}</span></td>
                <td class="text-end">${data.role === 'owner' ? `<button class="btn btn-sm btn-outline-danger delete-task-list-btn" data-id="${id}" data-name="${data.name || ''}"><i class="bi bi-trash"></i></button>` : ''}</td>
            </tr>`).join('');
        container.innerHTML = `<table class="table table-hover"><thead><tr><th>Nombre</th><th>Acceso</th><th></th></tr></thead><tbody>${tableRowsHtml}</tbody></table>`;
    }

    async function deleteTaskList(listId, listName) {
        if (!confirm(`¿Eliminar la lista "${listName}"? Es irreversible.`)) return;
        updateSaveStatus('Eliminando...');
        
        const batch = db.batch();
        const membersSnapshot = await db.collection('tareas').doc(listId).collection('members').get();
        membersSnapshot.forEach(doc => {
            batch.delete(db.collection('user_task_lists').doc(doc.id).collection('lists').doc(listId));
            batch.delete(doc.ref);
        });
        batch.delete(db.collection('tareas').doc(listId));
        await batch.commit();

        updateSaveStatus('Lista eliminada');
        if (currentTaskListId === listId) {
            if(taskListsModalInstance) taskListsModalInstance.hide();
            loadNewTaskListState(false);
        }
    }

    // --- MODO SOLO LECTURA ---
    function setReadOnly(isReadOnly) {
        isReadOnlyMode = isReadOnly;
        document.querySelectorAll('#app-container input, #app-container select, #app-container button').forEach(el => {
            if (!el.closest('.modal')) el.disabled = isReadOnly;
        });
        document.querySelectorAll('.drag-handle').forEach(el => { el.style.cursor = isReadOnly ? 'default' : 'move'; });
    }

    // --- EVENT LISTENERS GENERALES ---
    loginForm.addEventListener('submit', handleLogin);
    document.getElementById('signup-btn').addEventListener('click', handleSignUp);
    document.getElementById('google-signin-btn').addEventListener('click', handleGoogleSignIn);
    document.getElementById('logout-btn-sidebar').addEventListener('click', handleLogout);
    document.getElementById('forgot-password-link').addEventListener('click', handleForgotPassword);

    // --- LÓGICA DE TAREAS Y CÁLCULO GANTT ---
    function validateAndCorrectDates(row) {
        const startDateInput = row.querySelector('[name="taskStartDate"]');
        const endDateInput = row.querySelector('[name="taskEndDate"]');

        if (!startDateInput.value || !endDateInput.value) return;

        const startDate = new Date(startDateInput.value);
        const endDate = new Date(endDateInput.value);

        if (startDate > endDate) {
            if (document.activeElement === startDateInput) {
                endDateInput.value = startDateInput.value;
            } else {
                startDateInput.value = endDateInput.value;
            }
        }
    }

    function runGanttCalculationAndUpdateUI() {
        const currentTasks = getTasksData().tasks;
        const result = calculateTaskDates(currentTasks);
        
        if (result.error) {
            alert(result.error);
        }

        allTasksCache = result.tasks;
        updateTaskView();
        updateHeaderKPIs(allTasksCache);
        
        if (document.getElementById('gantt-tab-btn').classList.contains('active')) {
            renderGanttChart(allTasksCache);
        }
    }

    function updateHeaderKPIs(tasks) {
        const totalTasks = tasks.length;
        const completedTasks = tasks.filter(t => t.status === 'Completada');
        document.querySelector('#kpi1 .header-kpi-value').textContent = totalTasks;
        document.querySelector('#kpi2 .header-kpi-value').textContent = tasks.filter(t => t.status === 'Pendiente').length;
        document.querySelector('#kpi3 .header-kpi-value').textContent = tasks.filter(t => t.status === 'En Progreso').length;
        document.querySelector('#kpi4 .header-kpi-value').textContent = completedTasks.length;
        document.querySelector('#kpi5 .header-kpi-value').textContent = tasks.reduce((sum, task) => sum + (Number(task.value) || 0), 0).toLocaleString('es-CL');
        
        // --- CORRECCIÓN: Función auxiliar para parsear fechas sin problemas de zona horaria ---
        const parseDateAsLocal = (dateString) => {
            if (!dateString) return null;
            const [year, month, day] = dateString.split('-').map(Number);
            // new Date(year, monthIndex, day) - month es 0-indexado
            return new Date(year, month - 1, day);
        };

        const validStartDates = tasks.map(t => parseDateAsLocal(t.startDate)).filter(d => d);
        const validEndDates = tasks.map(t => parseDateAsLocal(t.endDate)).filter(d => d);

        const projectStartDate = validStartDates.length > 0 ? new Date(Math.min.apply(null, validStartDates)) : null;
        const projectEndDate = validEndDates.length > 0 ? new Date(Math.max.apply(null, validEndDates)) : null;
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        document.querySelector('#kpi9 .header-kpi-value').textContent = projectStartDate ? projectStartDate.toLocaleDateString('es-CL') : '--';
        document.querySelector('#kpi10 .header-kpi-value').textContent = projectEndDate ? projectEndDate.toLocaleDateString('es-CL') : '--';
        document.querySelector('#kpi11 .header-kpi-value').textContent = today.toLocaleDateString('es-CL');

        if (projectStartDate && projectEndDate && projectEndDate >= projectStartDate) {
            const totalDuration = projectEndDate - projectStartDate;
            const elapsedDuration = today - projectStartDate;
            const percentageElapsed = totalDuration > 0 ? Math.max(0, Math.min(100, (elapsedDuration / totalDuration) * 100)) : 0;
            document.querySelector('#kpi12 .header-kpi-value').textContent = `${percentageElapsed.toFixed(1)}%`;
        } else {
            document.querySelector('#kpi12 .header-kpi-value').textContent = '--';
        }

        const percentageCompleted = totalTasks > 0 ? (completedTasks.length / totalTasks) * 100 : 0;
        document.querySelector('#kpi13 .header-kpi-value').textContent = `${percentageCompleted.toFixed(1)}%`;
    }

    function addTaskRow(data = {}) {
        const newRow = document.createElement('tr');
        const taskId = data.id || crypto.randomUUID();
        newRow.dataset.taskId = taskId;
        
        const parentTask = taskViewStack.length > 0 && !isExpandedView ? taskViewStack[taskViewStack.length - 1] : null;
        const dependencies = data.dependencies || (parentTask ? [{ id: parentTask.taskId, type: 'Fin-Inicio (FI)' }] : []);
        
        newRow.dataset.dependencies = JSON.stringify(dependencies);

        const dependenciesCount = dependencies.length;
        const dependencyButtonText = dependenciesCount;
        
        const predButtonAttrs = isExpandedView ? '' : 'data-bs-toggle="modal" data-bs-target="#dependencyModal"';

        newRow.innerHTML = `
            <td class="drag-handle"><i class="bi bi-grip-vertical"></i></td>
            <td><input type="text" class="form-control form-control-sm" name="taskResponsible" value="${data.responsible || ''}"></td>
            <td><input type="text" class="form-control form-control-sm" name="taskName" value="${data.name || ''}"></td>
            <td><input type="number" class="form-control form-control-sm" name="taskValue" value="${data.value || 0}"></td>
            <td class="dependency-cell text-center">
                <button type="button" class="btn btn-sm btn-light w-100" ${predButtonAttrs} data-task-id="${taskId}">
                    ${dependencyButtonText}
                </button>
            </td>
            <td class="subtask-cell text-center">
                <button type="button" class="btn btn-sm btn-light w-100 subtask-count-btn" data-task-id="${taskId}">0</button>
            </td>
            <td><input type="date" class="form-control form-control-sm" name="taskStartDate" value="${data.startDate || ''}" ${data.startDateIsCalculated ? 'readonly' : ''}></td>
            <td><input type="date" class="form-control form-control-sm" name="taskEndDate" value="${data.endDate || ''}" ${data.endDateIsCalculated ? 'readonly' : ''}></td>
            <td class="duration-cell text-center align-middle">--</td>
            <td><select class="form-select form-select-sm" name="taskStatus"><option>Pendiente</option><option>En Progreso</option><option>Completada</option></select></td>
            <td><select class="form-select form-select-sm" name="taskPriority"><option>Baja</option><option>Media</option><option>Alta</option></select></td>
            <td><button type="button" class="btn btn-sm btn-outline-secondary remove-task-btn">X</button></td>`;
        
        if(data.status) newRow.querySelector('[name=taskStatus]').value = data.status;
        if(data.priority) newRow.querySelector('[name=taskPriority]').value = data.priority;
        
        newRow.querySelector('.remove-task-btn').addEventListener('click', () => {
            allTasksCache = allTasksCache.filter(t => t.id !== taskId);
            newRow.remove();
            runGanttCalculationAndUpdateUI();
            debouncedSaveToFirestore();
        });

        if (!data.id) {
            allTasksCache.push(getSingleTaskData(newRow));
        }
        
        return newRow;
    }
    
    function getSingleTaskData(row) {
        return {
            id: row.dataset.taskId,
            name: row.querySelector('[name=taskName]').value,
            responsible: row.querySelector('[name=taskResponsible]').value,
            value: parseFloat(row.querySelector('[name=taskValue]').value) || 0,
            dependencies: JSON.parse(row.dataset.dependencies || '[]'),
            startDate: row.querySelector('[name=taskStartDate]').value,
            endDate: row.querySelector('[name=taskEndDate]').value,
            status: row.querySelector('[name=taskStatus]').value,
            priority: row.querySelector('[name=taskPriority]').value,
        };
    }

    function getTasksData() {
        const visibleTasksMap = new Map();
        tasksTbody.querySelectorAll('tr').forEach(row => {
            visibleTasksMap.set(row.dataset.taskId, getSingleTaskData(row));
        });

        allTasksCache = allTasksCache.map(cachedTask => {
            return visibleTasksMap.get(cachedTask.id) || cachedTask;
        });

        return { 
            taskListName: document.getElementById('taskListName').value, 
            tasks: allTasksCache 
        };
    }
    
    function loadTasksFromJSON(data) {
        const result = calculateTaskDates(data.tasks || []);
        if (result.error) {
            alert(`Error en el archivo importado: ${result.error}`);
            // Cargar una lista vacía para evitar problemas
            document.getElementById('taskListName').value = data.taskListName || 'Nuevo Proyecto';
            allTasksCache = [];
        } else {
            document.getElementById('taskListName').value = data.taskListName || 'Nuevo Proyecto';
            allTasksCache = result.tasks;
        }
        
        taskViewStack = [];
        isExpandedView = false;
        runGanttCalculationAndUpdateUI();
    }

    // --- LÓGICA DE NAVEGACIÓN Y DEPENDENCIAS ---

    function getSuccessorIds(startTaskId, allTasks) {
        const successors = new Set();
        const queue = [startTaskId];
        const visited = new Set([startTaskId]);

        const taskMap = new Map(allTasks.map(t => [t.id, t.dependencies]));

        while (queue.length > 0) {
            const currentId = queue.shift();
            for (const [taskId, dependencies] of taskMap.entries()) {
                if (dependencies.some(dep => dep.id === currentId)) {
                    if (!visited.has(taskId)) {
                        successors.add(taskId);
                        visited.add(taskId);
                        queue.push(taskId);
                    }
                }
            }
        }
        return successors;
    }

    function calculateSubtaskCounts(tasks) {
        const counts = {};
        tasks.forEach(task => {
            task.dependencies.forEach(dep => {
                counts[dep.id] = (counts[dep.id] || 0) + 1;
            });
        });
        return counts;
    }

    function updateTaskView() {
        const parentTask = taskViewStack.length > 0 ? taskViewStack[taskViewStack.length - 1] : null;
        let tasksToShow;

        const breadcrumbEl = document.getElementById('breadcrumb-title');
        const toggleBtn = document.getElementById('toggle-expand-btn');
        const toggleBtnIcon = toggleBtn ? toggleBtn.querySelector('i') : null;

        if (isExpandedView) {
            tasksToShow = allTasksCache;
            if (breadcrumbEl) breadcrumbEl.style.display = 'none';
            if (toggleBtnIcon) toggleBtnIcon.className = 'bi bi-arrows-collapse';
            if (toggleBtn) toggleBtn.setAttribute('data-bs-original-title', 'Colapsar vista');
        } else {
            if (parentTask) {
                tasksToShow = allTasksCache.filter(task => 
                    task.dependencies.some(dep => dep.id === parentTask.taskId)
                );
                if (breadcrumbEl) {
                    const prefix = taskViewStack.length > 1 ? '... / ' : '';
                    breadcrumbEl.textContent = `/ ${prefix}${parentTask.taskName}`;
                    breadcrumbEl.classList.add('clickable-title');
                    breadcrumbEl.style.display = 'inline';
                }
            } else {
                const allTaskIds = new Set(allTasksCache.map(t => t.id));
                tasksToShow = allTasksCache.filter(task => 
                    task.dependencies.length === 0 || task.dependencies.every(dep => !allTaskIds.has(dep.id))
                );
                if (breadcrumbEl) breadcrumbEl.style.display = 'none';
            }
            if (toggleBtnIcon) toggleBtnIcon.className = 'bi bi-arrows-fullscreen';
            if (toggleBtn) toggleBtn.setAttribute('data-bs-original-title', 'Expandir todo');
        }
        
        if (toggleBtn) new bootstrap.Tooltip(toggleBtn);

        renderTaskRows(tasksToShow);
    }

    function renderTaskRows(tasksToRender) {
        tasksTbody.innerHTML = '';
        const subtaskCounts = calculateSubtaskCounts(allTasksCache);

        tasksToRender.forEach(taskData => {
            const newRow = addTaskRow(taskData);
            
            const durationCell = newRow.querySelector('.duration-cell');
            if (taskData.startDate && taskData.endDate) {
                const start = new Date(taskData.startDate);
                const end = new Date(taskData.endDate);
                const duration = Math.round((end - start) / (1000 * 60 * 60 * 24)) + 1;
                durationCell.textContent = duration;
            } else {
                durationCell.textContent = '--';
            }

            const subtaskBtn = newRow.querySelector('.subtask-count-btn');
            const count = subtaskCounts[taskData.id] || 0;
            subtaskBtn.textContent = count;
            if (count === 0) {
                subtaskBtn.disabled = true;
            }

            tasksTbody.appendChild(newRow);
        });
    }

    function navigateToSubtasks(taskId) {
        const task = allTasksCache.find(t => t.id === taskId);
        if (task) {
            taskViewStack.push({ taskId: task.id, taskName: task.name });
            updateTaskView();
        }
    }

    function navigateUp() {
        if (taskViewStack.length > 0) {
            taskViewStack.pop();
            updateTaskView();
        }
    }

    function initDependencyModal() {
        const modalEl = document.getElementById('dependencyModal');
        if (!modalEl) return;
        dependencyModalInstance = new bootstrap.Modal(modalEl);

        modalEl.addEventListener('show.bs.modal', (event) => {
            const button = event.relatedTarget;
            if (!button) return;
            currentEditingTaskId = button.getAttribute('data-task-id');
            populateDependencyModal(currentEditingTaskId);
        });
    }

    function populateDependencyModal(editingTaskId) {
        const allTasks = getTasksData().tasks;
        const editingTask = allTasks.find(t => t.id === editingTaskId);
        const currentDependencies = editingTask.dependencies || [];
        
        const successorIds = getSuccessorIds(editingTaskId, allTasks);
        const availableTasks = allTasks.filter(t => t.id !== editingTaskId && !successorIds.has(t.id));

        document.getElementById('dependency-task-name').textContent = editingTask.name || 'Tarea sin nombre';
        const searchInput = document.getElementById('dependency-search-input');
        const checkedFilter = document.getElementById('dependency-checked-filter');
        searchInput.value = '';
        checkedFilter.checked = false;

        const renderList = () => {
            const searchTerm = searchInput.value.toLowerCase();
            const onlyChecked = checkedFilter.checked;
            const container = document.getElementById('dependency-modal-body-content');
            container.innerHTML = '';

            let filteredTasks = availableTasks;

            if (searchTerm) {
                filteredTasks = filteredTasks.filter(task => task.name.toLowerCase().includes(searchTerm));
            }
            
            const currentDependencyIds = new Set(currentDependencies.map(d => d.id));
            if (onlyChecked) {
                filteredTasks = filteredTasks.filter(task => currentDependencyIds.has(task.id));
            }

            if (filteredTasks.length === 0) {
                container.innerHTML = '<p class="text-muted">No se encontraron tareas con los filtros aplicados.</p>';
                return;
            }

            const table = document.createElement('table');
            table.className = 'table table-sm';
            table.innerHTML = `<thead><tr><th style="width: 50px;"></th><th>Tarea</th><th>Tipo de Dependencia</th></tr></thead>`;
            const tbody = document.createElement('tbody');

            filteredTasks.forEach(task => {
                const dependency = currentDependencies.find(d => d.id === task.id);
                const isChecked = !!dependency;
                const dependencyType = dependency ? dependency.type : 'Fin-Inicio (FI)';

                const row = document.createElement('tr');
                row.innerHTML = `
                    <td>
                        <div class="form-check">
                            <input class="form-check-input dependency-checkbox" type="checkbox" value="${task.id}" ${isChecked ? 'checked' : ''}>
                        </div>
                    </td>
                    <td>${task.name || 'Tarea sin nombre'}</td>
                    <td>
                        <select class="form-select form-select-sm dependency-type-select" ${!isChecked ? 'disabled' : ''}>
                            <option value="Fin-Inicio (FI)" ${dependencyType === 'Fin-Inicio (FI)' ? 'selected' : ''}>Fin-Inicio (FI)</option>
                            <option value="Inicio-Inicio (II)" ${dependencyType === 'Inicio-Inicio (II)' ? 'selected' : ''}>Inicio-Inicio (II)</option>
                            <option value="Fin-Fin (FF)" ${dependencyType === 'Fin-Fin (FF)' ? 'selected' : ''}>Fin-Fin (FF)</option>
                            <option value="Inicio-Fin (IF)" ${dependencyType === 'Inicio-Fin (IF)' ? 'selected' : ''}>Inicio-Fin (IF)</option>
                        </select>
                    </td>
                `;
                tbody.appendChild(row);
            });

            table.appendChild(tbody);
            container.appendChild(table);

            container.querySelectorAll('.dependency-checkbox').forEach(checkbox => {
                checkbox.addEventListener('change', (e) => {
                    const select = e.target.closest('tr').querySelector('.dependency-type-select');
                    select.disabled = !e.target.checked;
                });
            });
        };

        searchInput.oninput = renderList;
        checkedFilter.onchange = renderList;
        document.getElementById('save-dependencies-btn').onclick = saveDependencies;

        renderList();
    }

    function saveDependencies() {
        const newDependencies = [];
        document.querySelectorAll('#dependency-modal-body-content .dependency-checkbox:checked').forEach(checkbox => {
            const row = checkbox.closest('tr');
            const typeSelect = row.querySelector('.dependency-type-select');
            newDependencies.push({
                id: checkbox.value,
                type: typeSelect.value
            });
        });

        const otherDependencies = (allTasksCache.find(t => t.id === currentEditingTaskId)?.dependencies || [])
            .filter(dep => !document.querySelector(`#dependency-modal-body-content .dependency-checkbox[value="${dep.id}"]`));

        const finalDependencies = [...otherDependencies, ...newDependencies];

        const taskRow = tasksTbody.querySelector(`tr[data-task-id="${currentEditingTaskId}"]`);
        if (taskRow) {
            taskRow.dataset.dependencies = JSON.stringify(finalDependencies);
            const button = taskRow.querySelector('.dependency-cell button');
            button.textContent = finalDependencies.length;
        }

        dependencyModalInstance.hide();
        runGanttCalculationAndUpdateUI();
        debouncedSaveToFirestore();
    }

    function initSortable(tbodyElement) { if (tbodyElement) new Sortable(tbodyElement, { animation: 150, handle: '.drag-handle', onEnd: debouncedSaveToFirestore, }); }
    
    // --- IMPORT/EXPORT/COPIAR ---
    function downloadFile(content, filename, mimeType) { const blob = new Blob([`\uFEFF${content}`], { type: mimeType }); const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = filename; link.click(); }
    document.getElementById('export-model-btn').addEventListener('click', () => { const data = getTasksData(); downloadFile(JSON.stringify(data, null, 2), `tareas_${data.taskListName.replace(/[^a-z0-9]/gi, '_')}.json`, 'application/json'); });
    document.getElementById('import-file-input').addEventListener('change', (event) => { const file = event.target.files[0]; if (!file) return; const reader = new FileReader(); reader.onload = (e) => { try { const params = JSON.parse(e.target.result); const validationResult = calculateTaskDates(params.tasks || []); if (validationResult.error) { alert(`Error en el archivo importado: ${validationResult.error}`); return; } loadTasksFromJSON(params); alert("Tareas importadas."); saveTaskListToFirestore(); } catch { alert("Archivo JSON no válido."); } }; reader.readAsText(file); event.target.value = ''; });
    document.getElementById('copy-tasks-btn').addEventListener('click', () => { const table = document.querySelector('#tasks table'); if (!table) return; const tsv = Array.from(table.querySelectorAll('tr')).map(r => Array.from(r.querySelectorAll('th, td')).slice(1, -1).map(c => `"${(c.querySelector('input, select')?.value || c.textContent).trim()}"`).join('\t')).join('\n'); navigator.clipboard.writeText(tsv).then(() => alert('Tabla copiada.')); });

    // --- ESTADO DE GUARDADO ---
    const saveStatusEl = document.getElementById('save-status');
    let saveTimeout;
    function updateSaveStatus(status, isError = false) { clearTimeout(saveTimeout); saveStatusEl.style.opacity = 1; if (isError) { saveStatusEl.innerHTML = `<i class="bi bi-x-circle-fill text-danger"></i> ${status}`; } else if (status.includes('...')) { saveStatusEl.innerHTML = `<span class="spinner-border spinner-border-sm"></span> ${status}`; } else { saveStatusEl.innerHTML = `<i class="bi bi-check-circle-fill text-success"></i> ${status}`; saveTimeout = setTimeout(() => { saveStatusEl.style.opacity = 0; }, 2000); } }
});