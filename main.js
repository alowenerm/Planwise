document.addEventListener('DOMContentLoaded', function() {
    
    // --- VARIABLES GLOBALES ---
    let currentUserId = null;
    let currentTaskListId = null;
    let currentUserRole = null;
    let taskListListener = null;
    let membersListener = null;
    let userTaskListsListener = null;
    let lastKnownServerState = null;
    let isReadOnlyMode = false;
    
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
    
    let taskCounter = 0;

    // Inicializar Tooltips de Bootstrap
    const tooltipTriggerList = document.querySelectorAll('[data-bs-toggle="tooltip"]');
    [...tooltipTriggerList].map(tooltipTriggerEl => new bootstrap.Tooltip(tooltipTriggerEl));

    // --- FUNCIONES DE AUTENTICACIÓN (Sin cambios) ---
    const showAuthMessage = (message, type = 'danger') => {
        authErrorEl.textContent = message;
        authErrorEl.className = `alert alert-${type}`;
        authErrorEl.style.display = 'block';
    };
    const clearAuthError = () => { 
        authErrorEl.style.display = 'none'; 
        authErrorEl.className = 'alert alert-danger';
    };
    const handleLogin = (e) => {
        e.preventDefault();
        clearAuthError();
        const email = document.getElementById('email').value;
        const password = document.getElementById('password').value;
        auth.signInWithEmailAndPassword(email, password).catch(error => showAuthMessage("Correo o contraseña incorrectos."));
    };
    const handleSignUp = () => {
        clearAuthError();
        const email = document.getElementById('email').value;
        const password = document.getElementById('password').value;
        if (password.length < 6) {
            showAuthMessage("La contraseña debe tener al menos 6 caracteres.");
            return;
        }
        auth.createUserWithEmailAndPassword(email, password).catch(error => {
            if (error.code === 'auth/email-already-in-use') {
                showAuthMessage("Este correo electrónico ya está registrado.");
            } else {
                showAuthMessage("Error al registrar el usuario: " + error.message);
            }
        });
    };
    const handleGoogleSignIn = () => {
        clearAuthError();
        const provider = new firebase.auth.GoogleAuthProvider();
        auth.signInWithPopup(provider).catch(error => showAuthMessage("No se pudo iniciar sesión con Google."));
    };
    const handleForgotPassword = (e) => {
        e.preventDefault();
        clearAuthError();
        const email = document.getElementById('email').value;
        if (!email) {
            showAuthMessage("Por favor, ingresa tu correo para recuperar la contraseña.");
            return;
        }
        auth.sendPasswordResetEmail(email)
            .then(() => showAuthMessage("Se ha enviado un correo para restablecer tu contraseña.", 'success'))
            .catch(() => showAuthMessage("Ocurrió un error al enviar el correo de recuperación."));
    };
    const handleLogout = () => {
        if (membersListener && currentTaskListId) db.ref(`tarea_members/${currentTaskListId}`).off('value', membersListener);
        if (userTaskListsListener && currentUserId) db.ref(`user_tareas/${currentUserId}`).off('value', userTaskListsListener);
        if (taskListListener && currentTaskListId) db.ref(`tareas/${currentTaskListId}`).off('value', taskListListener);
        
        history.pushState(null, '', window.location.pathname);
        auth.signOut();
    };

    // --- OBSERVADOR DE AUTENTICACIÓN ---
    auth.onAuthStateChanged(user => {
        if (user) {
            handleUserLogin(user);
        } else {
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
        const userRef = db.ref(`users/${user.uid}`);
        userRef.once('value', snapshot => {
            if (!snapshot.exists()) {
                const registrationDate = new Date();
                const subscriptionExpiry = new Date();
                subscriptionExpiry.setDate(registrationDate.getDate() + 30);
                const newUserInfo = {
                    email: user.email,
                    registrationDate: registrationDate.toISOString(),
                    subscriptionExpiry: subscriptionExpiry.toISOString(),
                    authProvider: user.providerData[0].providerId
                };
                userRef.set(newUserInfo).then(() => proceedToApp(user));
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
        db.ref(`email_to_uid/${user.email.replace(/\./g, ',')}`).set(user.uid);
        initializeAppLogic();
        initShareFunctionality();
        initTaskListsModal();
    }

    // --- LÓGICA DE LA APLICACIÓN ---
    async function initializeAppLogic() {
        document.getElementById('new-task-list-btn').addEventListener('click', () => loadNewTaskListState(true));
        
        const taskListNameInput = document.getElementById('taskListName');
        taskListNameInput.addEventListener('input', debouncedSaveToFirestore);
        taskListNameInput.addEventListener('change', debouncedSaveToFirestore);

        document.getElementById('tasks').addEventListener('change', debouncedSaveToFirestore);
        document.getElementById('add-task').addEventListener('click', () => { 
            addTaskRow(); 
            debouncedSaveToFirestore();
        });

        const sidebarToggle = document.getElementById('sidebar-toggle');
        sidebarToggle.addEventListener('click', () => {
            document.body.classList.toggle('sidebar-collapsed');
            const icon = sidebarToggle.querySelector('i');
            icon.className = document.body.classList.contains('sidebar-collapsed') ? 'bi bi-chevron-right' : 'bi-chevron-left';
        });
        sidebarToggle.querySelector('i').className = document.body.classList.contains('sidebar-collapsed') ? 'bi bi-chevron-right' : 'bi-chevron-left';

        initSortable(tasksTbody);

        const initialTaskListId = getTaskListIdFromUrl();
        if (initialTaskListId) {
            await listenToTaskList(initialTaskListId);
        } else {
            loadNewTaskListState(false); 
        }
    }
  
    async function loadNewTaskListState(confirmFirst = false) {
        if (confirmFirst && !confirm("¿Desea crear una nueva lista de tareas?")) {
            return;
        }

        if (taskListListener && currentTaskListId) db.ref(`tareas/${currentTaskListId}`).off('value', taskListListener);
        if (membersListener && currentTaskListId) db.ref(`tarea_members/${currentTaskListId}`).off('value', membersListener);

        currentTaskListId = null;
        currentUserRole = 'owner';
        lastKnownServerState = null;
        
        if (window.location.search !== "") {
            history.pushState({ path: window.location.pathname }, '', window.location.pathname);
        }

        setReadOnly(false);
        document.getElementById('share-task-list-btn').style.display = 'none';
        
        loadTasksFromJSON({ taskListName: 'Nueva Lista de Tareas', tasks: [] });
        saveTaskListToFirestore();
    }    

    // --- FUNCIONES DE DATOS ---
    async function saveTaskListToFirestore() {
        if (!currentUserId || isReadOnlyMode) return;

        const data = getTasksData();
        
        // Calcular KPIs
        const totalTasks = data.tasks.length;
        const pendingTasks = data.tasks.filter(t => t.status === 'Pendiente').length;
        const inProgressTasks = data.tasks.filter(t => t.status === 'En Progreso').length;
        const completedTasks = data.tasks.filter(t => t.status === 'Completada').length;
        
        const taskListDataToSave = {
            ...data,
            lastUpdated: new Date().toISOString(),
            kpi_total: totalTasks,
            kpi_pending: pendingTasks,
            kpi_in_progress: inProgressTasks,
            kpi_completed: completedTasks
        };

        lastKnownServerState = JSON.stringify(taskListDataToSave);

        if (!currentTaskListId) {
            updateSaveStatus('Creando lista...');
            try {
                const newTaskListRef = db.ref('tareas').push();
                const newTaskListId = newTaskListRef.key;
                
                taskListDataToSave.creationDate = new Date().toISOString();

                const ownerData = { email: auth.currentUser.email, role: 'owner' };
                const userTaskListData = { 
                    name: data.taskListName, 
                    role: 'owner',
                    lastUpdated: taskListDataToSave.lastUpdated,
                    creationDate: taskListDataToSave.creationDate,
                };
                
                const updates = {};
                updates[`/tareas/${newTaskListId}`] = taskListDataToSave;
                updates[`/tarea_members/${newTaskListId}/${currentUserId}`] = ownerData;
                updates[`/user_tareas/${currentUserId}/${newTaskListId}`] = userTaskListData;

                await db.ref().update(updates);

                const newUrl = `${window.location.pathname}?id=${newTaskListId}`;
                history.pushState({ path: newUrl }, '', newUrl);
                await listenToTaskList(newTaskListId);
                updateSaveStatus('Guardado');
            } catch (error) {
                console.error("Error creando lista:", error);
                updateSaveStatus('Error al crear', true);
            }
        } else {
            updateSaveStatus('Guardando...');
            try {
                const updates = {};
                updates[`/tareas/${currentTaskListId}`] = taskListDataToSave;
                
                const membersSnapshot = await db.ref(`tarea_members/${currentTaskListId}`).once('value');
                if (membersSnapshot.exists()) {
                    const members = membersSnapshot.val();
                    Object.keys(members).forEach(uid => {
                        updates[`/user_tareas/${uid}/${currentTaskListId}/name`] = data.taskListName;
                        updates[`/user_tareas/${uid}/${currentTaskListId}/lastUpdated`] = taskListDataToSave.lastUpdated;
                    });
                }

                await db.ref().update(updates);
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

        if (taskListListener && currentTaskListId) {
            db.ref(`tareas/${currentTaskListId}`).off('value', taskListListener);
        }

        currentTaskListId = taskListId;
        
        const memberSnapshot = await db.ref(`tarea_members/${currentTaskListId}/${currentUserId}`).once('value');
        currentUserRole = memberSnapshot.exists() ? memberSnapshot.val().role : null;

        if (!currentUserRole) {
            alert("No tienes acceso a esta lista. Se cargará una nueva.");
            loadNewTaskListState(false);
            return;
        }

        isReadOnlyMode = (currentUserRole === 'viewer');
        setReadOnly(isReadOnlyMode);
        
        const shareBtn = document.getElementById('share-task-list-btn');
        shareBtn.style.display = 'block';
        shareBtn.disabled = (currentUserRole !== 'owner');

        updateSaveStatus('Cargando lista...');
        const taskListRef = db.ref(`tareas/${taskListId}`);

        taskListListener = taskListRef.on('value', (snapshot) => {
            if (snapshot.exists()) {
                const serverData = snapshot.val();
                if (JSON.stringify(serverData) === lastKnownServerState) return;
                
                lastKnownServerState = JSON.stringify(serverData); 
                updateSaveStatus('Actualizando...');
                const activeElId = document.activeElement ? document.activeElement.id : null;
                
                loadTasksFromJSON(serverData);
                
                if (activeElId && document.getElementById(activeElId)) {
                    document.getElementById(activeElId).focus();
                }
                updateSaveStatus('Actualizado');
            } else {
                alert("La lista solicitada no existe. Se cargará una nueva.");
                if (taskListListener) taskListRef.off('value', taskListListener);
                loadNewTaskListState(false);
            }
        });
    }

    // --- FUNCIONES PARA COMPARTIR ---
    let shareModalInstance = null;

    function initShareFunctionality() {
        const shareBtn = document.getElementById('share-task-list-btn');
        shareBtn.style.display = 'none';
        if (!shareModalInstance) {
            shareModalInstance = new bootstrap.Modal(document.getElementById('shareModal'));
        }
        shareBtn.addEventListener('click', openShareModal);
        document.getElementById('add-user-btn').addEventListener('click', addUserToList);
        document.getElementById('user-access-list').addEventListener('click', (e) => {
            if (e.target.matches('.remove-user-btn')) removeUserFromList(e.target.dataset.uid);
        });
        document.getElementById('user-access-list').addEventListener('change', (e) => {
            if (e.target.matches('.role-select')) updateUserRole(e.target.dataset.uid, e.target.value);
        });
    }

    function openShareModal() {
        if (!currentTaskListId) return;
        document.getElementById('share-error').style.display = 'none';
        document.getElementById('share-email-input').value = '';
        const membersRef = db.ref(`tarea_members/${currentTaskListId}`);
        if (membersListener) membersRef.off('value', membersListener);
        membersListener = membersRef.on('value', snapshot => renderUserList(snapshot.val()));
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
            
            const roleDisplay = isCurrentUserOwner ? `<span class="badge bg-success rounded-pill">Propietario</span>` : `
                <select class="form-select form-select-sm role-select" data-uid="${uid}" ${!isOwner ? 'disabled' : ''}>
                    <option value="editor" ${userData.role === 'editor' ? 'selected' : ''}>Editor</option>
                    <option value="viewer" ${userData.role === 'viewer' ? 'selected' : ''}>Solo Lectura</option>
                </select>`;
            
            const actionBtn = (isOwner && uid !== currentUserId) ? `<button class="btn btn-sm btn-outline-danger remove-user-btn" data-uid="${uid}"><i class="bi bi-trash"></i></button>` : '';

            li.innerHTML = `
                <div>${userData.email || '...'}</div>
                <div class="d-flex align-items-center gap-2">
                    <div class="role-select-cell">${roleDisplay}</div>
                    <div class="action-btn-cell">${actionBtn}</div>
                </div>`;
            userListEl.appendChild(li);
        });
    }

    async function updateUserRole(uid, newRole) {
        if (!currentTaskListId) return;
        const updates = {};
        updates[`/tarea_members/${currentTaskListId}/${uid}/role`] = newRole;
        updates[`/user_tareas/${uid}/${currentTaskListId}/role`] = newRole;
        await db.ref().update(updates);
    }

    async function addUserToList() {
        const email = document.getElementById('share-email-input').value.trim();
        const errorEl = document.getElementById('share-error');
        errorEl.style.display = 'none';
        if (!email) {
            errorEl.textContent = 'Introduce un correo.';
            errorEl.style.display = 'block';
            return;
        }
        
        try {
            const uidSnapshot = await db.ref(`email_to_uid/${email.replace(/\./g, ',')}`).once('value');
            if (!uidSnapshot.exists()) {
                errorEl.textContent = 'Usuario no encontrado.';
                errorEl.style.display = 'block';
                return;
            }
            const targetUid = uidSnapshot.val();
            const role = document.getElementById('share-role-select').value;
            const taskListData = getTasksData();
            
            const memberData = { email: email, role: role };
            const userTaskListData = { name: taskListData.taskListName, role: role, lastUpdated: new Date().toISOString() };

            const updates = {};
            updates[`/tarea_members/${currentTaskListId}/${targetUid}`] = memberData;
            updates[`/user_tareas/${targetUid}/${currentTaskListId}`] = userTaskListData;
            await db.ref().update(updates);
            document.getElementById('share-email-input').value = '';
        } catch (error) {
            errorEl.textContent = 'Ocurrió un error al compartir.';
            errorEl.style.display = 'block';
        }
    }

    async function removeUserFromList(uidToRemove) {
        if (!confirm("¿Quitar acceso a este usuario?")) return;
        const updates = {};
        updates[`/tarea_members/${currentTaskListId}/${uidToRemove}`] = null;
        updates[`/user_tareas/${uidToRemove}/${currentTaskListId}`] = null;
        await db.ref().update(updates);
    }

    // --- FUNCIONES PARA LISTAR Y ABRIR LISTAS ---
    let taskListsModalInstance = null;

    function initTaskListsModal() {
        if (!taskListsModalInstance) {
            taskListsModalInstance = new bootstrap.Modal(document.getElementById('taskListsModal'));
        }
        document.getElementById('open-task-lists-btn').addEventListener('click', () => {
            taskListsModalInstance.show();
        });

        if (userTaskListsListener && currentUserId) db.ref(`user_tareas/${currentUserId}`).off('value', userTaskListsListener);
        userTaskListsListener = db.ref(`user_tareas/${currentUserId}`).on('value', snapshot => renderTaskLists(snapshot.val()));

        document.getElementById('task-list-container').addEventListener('click', e => {
            const deleteBtn = e.target.closest('.delete-task-list-btn');
            if (deleteBtn) {
                e.stopPropagation();
                deleteTaskList(deleteBtn.dataset.id, deleteBtn.dataset.name);
            } else {
                const row = e.target.closest('.task-list-row');
                if (row) window.location.href = row.dataset.href;
            }
        });
    }

    function renderTaskLists(lists) {
        const container = document.getElementById('task-list-container');
        if (!lists) {
            container.innerHTML = '<p class="text-muted text-center mt-3">No tienes listas de tareas.</p>';
            return;
        }

        const tableRowsHtml = Object.entries(lists).map(([id, data]) => {
            const roleText = data.role === 'owner' ? 'Propietario' : 'Editor';
            const lastUpdated = data.lastUpdated ? new Date(data.lastUpdated).toLocaleString('es-CL') : 'N/A';
            const deleteButton = data.role === 'owner' 
                ? `<button class="btn btn-sm btn-outline-danger delete-task-list-btn" data-id="${id}" data-name="${data.name || ''}"><i class="bi bi-trash"></i></button>`
                : '';

            return `
                <tr class="task-list-row align-middle" data-href="${window.location.pathname}?id=${id}">
                    <td>${data.name || 'Lista sin nombre'}</td>
                    <td><span class="badge bg-light text-dark border rounded-pill">${roleText}</span></td>
                    <td class="text-center">${lastUpdated}</td>
                    <td class="action-btn-cell">${deleteButton}</td>
                </tr>`;
        }).join('');

        container.innerHTML = `
            <table class="table table-hover">
                <thead class="table-light">
                    <tr><th>Nombre de la Lista</th><th>Acceso</th><th class="text-center">Última Modificación</th><th>Acciones</th></tr>
                </thead>
                <tbody>${tableRowsHtml}</tbody>
            </table>`;
    }

    async function deleteTaskList(listId, listName) {
        if (!confirm(`¿Eliminar la lista "${listName}"? Esta acción es irreversible.`)) return;

        updateSaveStatus('Eliminando...');
        if (currentTaskListId === listId && taskListListener) {
            db.ref(`tareas/${listId}`).off('value', taskListListener);
        }

        const membersSnapshot = await db.ref(`tarea_members/${listId}`).once('value');
        const updates = {};
        updates[`/tareas/${listId}`] = null;
        updates[`/tarea_members/${listId}`] = null;

        if (membersSnapshot.exists()) {
            Object.keys(membersSnapshot.val()).forEach(uid => {
                updates[`/user_tareas/${uid}/${listId}`] = null;
            });
        }
        await db.ref().update(updates);
        updateSaveStatus('Lista eliminada');
        
        if (currentTaskListId === listId) {
            if(taskListsModalInstance) taskListsModalInstance.hide();
            loadNewTaskListState(false);
        }
    }

    // --- MODO SOLO LECTURA ---
    function setReadOnly(isReadOnly) {
        isReadOnlyMode = isReadOnly;
        document.querySelectorAll('#app-container input, #app-container select').forEach(el => {
            el.disabled = isReadOnly;
        });
        document.querySelectorAll('#app-container button, .drag-handle').forEach(btn => {
            if (!btn.closest('.modal')) { // No deshabilitar botones de modales
                 btn.style.display = isReadOnly ? 'none' : '';
            }
        });
    }

    // --- EVENT LISTENERS GENERALES ---
    loginForm.addEventListener('submit', handleLogin);
    document.getElementById('signup-btn').addEventListener('click', handleSignUp);
    document.getElementById('google-signin-btn').addEventListener('click', handleGoogleSignIn);
    document.getElementById('logout-btn-sidebar').addEventListener('click', handleLogout);
    document.getElementById('forgot-password-link').addEventListener('click', handleForgotPassword);

    // --- LÓGICA DE LA INTERFAZ DE TAREAS ---
    function updateHeaderKPIs() {
        const tasks = getTasksData().tasks;
        const total = tasks.length;
        const pending = tasks.filter(t => t.status === 'Pendiente').length;
        const inProgress = tasks.filter(t => t.status === 'En Progreso').length;
        const completed = tasks.filter(t => t.status === 'Completada').length;
        
        document.querySelector('#kpi1 .header-kpi-value').textContent = total;
        document.querySelector('#kpi2 .header-kpi-value').textContent = pending;
        document.querySelector('#kpi3 .header-kpi-value').textContent = inProgress;
        document.querySelector('#kpi4 .header-kpi-value').textContent = completed;
        // Resto de KPIs quedan en --
    }

    function addTaskRow(data = {}) {
        taskCounter++;
        const newRow = document.createElement('tr');
        newRow.id = `task-row-${taskCounter}`;
        newRow.innerHTML = `
            <td class="drag-handle"><i class="bi bi-grip-vertical"></i></td>
            <td><input type="text" class="form-control form-control-sm" name="taskName" value="${data.name || ''}"></td>
            <td><input type="text" class="form-control form-control-sm" name="taskResponsible" value="${data.responsible || ''}"></td>
            <td><input type="date" class="form-control form-control-sm" name="taskStartDate" value="${data.startDate || ''}"></td>
            <td><input type="date" class="form-control form-control-sm" name="taskEndDate" value="${data.endDate || ''}"></td>
            <td>
                <select class="form-select form-select-sm" name="taskStatus">
                    <option value="Pendiente" ${data.status === 'Pendiente' ? 'selected' : ''}>Pendiente</option>
                    <option value="En Progreso" ${data.status === 'En Progreso' ? 'selected' : ''}>En Progreso</option>
                    <option value="Completada" ${data.status === 'Completada' ? 'selected' : ''}>Completada</option>
                </select>
            </td>
            <td>
                <select class="form-select form-select-sm" name="taskPriority">
                    <option value="Baja" ${data.priority === 'Baja' ? 'selected' : ''}>Baja</option>
                    <option value="Media" ${data.priority === 'Media' ? 'selected' : ''}>Media</option>
                    <option value="Alta" ${data.priority === 'Alta' ? 'selected' : ''}>Alta</option>
                </select>
            </td>
            <td><button type="button" class="btn btn-sm btn-outline-secondary" onclick="removeRow('task-row-${taskCounter}')">X</button></td>
        `;
        tasksTbody.appendChild(newRow);
        updateHeaderKPIs();
    }

    window.removeRow = function(rowId) {
        document.getElementById(rowId).remove();
        updateHeaderKPIs();
        debouncedSaveToFirestore();
    }
    
    function getTasksData() {
        const data = {
            taskListName: document.getElementById('taskListName').value,
            tasks: []
        };
        tasksTbody.querySelectorAll('tr').forEach(r => {
            data.tasks.push({
                name: r.querySelector('[name=taskName]').value,
                responsible: r.querySelector('[name=taskResponsible]').value,
                startDate: r.querySelector('[name=taskStartDate]').value,
                endDate: r.querySelector('[name=taskEndDate]').value,
                status: r.querySelector('[name=taskStatus]').value,
                priority: r.querySelector('[name=taskPriority]').value,
            });
        });
        return data;
    }
    
    function loadTasksFromJSON(data) {
        tasksTbody.innerHTML = '';
        taskCounter = 0;

        document.getElementById('taskListName').value = data.taskListName || 'Nueva Lista de Tareas';
        
        if (Array.isArray(data.tasks)) {
            data.tasks.forEach(taskData => addTaskRow(taskData));
        }
        
        updateHeaderKPIs();
    }

    function initSortable(tbodyElement) {
        if (tbodyElement) {
            new Sortable(tbodyElement, {
                animation: 150, handle: '.drag-handle', ghostClass: 'sortable-ghost',
                onEnd: debouncedSaveToFirestore,
            });
        }
    }
    
    // --- IMPORT/EXPORT ---
    function handleExportJSON() {
        const data = getTasksData();
        const jsonContent = JSON.stringify(data, null, 2);
        const listName = data.taskListName.replace(/[^a-z0-9]/gi, '_').toLowerCase() || 'lista_tareas';
        downloadFile(jsonContent, `tareas_${listName}.json`, 'application/json;charset=utf-8;');
    }
    
    function handleImportJSON(event) {
        const file = event.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = function(e) {
            try {
                const params = JSON.parse(e.target.result);
                if (!params || typeof params.tasks === 'undefined') {
                    throw new Error("El archivo JSON no tiene el formato de tareas esperado.");
                }
                loadTasksFromJSON(params);
                alert("Tareas importadas con éxito.");
                saveTaskListToFirestore();
            } catch (error) {
                alert("El archivo JSON no es válido.");
            } finally {
                event.target.value = '';
            }
        };
        reader.readAsText(file);
    }

    function downloadFile(content, filename, mimeType) {
        const blob = new Blob([`\uFEFF${content}`], { type: mimeType });
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = filename;
        link.click();
    }

    document.getElementById('export-model-btn').addEventListener('click', handleExportJSON);
    document.getElementById('import-file-input').addEventListener('change', handleImportJSON);

    // --- COPIAR AL PORTAPAPELES ---
    document.getElementById('copy-tasks-btn').addEventListener('click', function() {
        const table = document.querySelector('#tasks table');
        if (!table) return;
        
        const tsvContent = Array.from(table.querySelectorAll('tr')).map(row => 
            Array.from(row.querySelectorAll('th, td')).slice(1, -1) // Omitir agarrador y botón
            .map(cell => {
                const input = cell.querySelector('input, select');
                return `"${(input ? input.value : cell.textContent).trim().replace(/"/g, '""')}"`;
            }).join('\t')
        ).join('\n');

        navigator.clipboard.writeText(tsvContent).then(() => alert('Tabla de tareas copiada.'));
    });

    // --- ESTADO DE GUARDADO ---
    const saveStatusEl = document.getElementById('save-status');
    let saveTimeout;
    function updateSaveStatus(status, isError = false) {
        clearTimeout(saveTimeout);
        saveStatusEl.style.opacity = 1;
        if (isError) {
            saveStatusEl.innerHTML = `<i class="bi bi-x-circle-fill text-danger"></i> ${status}`;
        } else if (status.includes('...')) {
            saveStatusEl.innerHTML = `<span class="spinner-border spinner-border-sm"></span> ${status}`;
        } else {
            saveStatusEl.innerHTML = `<i class="bi bi-check-circle-fill text-success"></i> ${status}`;
            saveTimeout = setTimeout(() => { saveStatusEl.style.opacity = 0; }, 2000);
        }
    }
});