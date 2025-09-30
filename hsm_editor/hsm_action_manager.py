import tkinter as tk
from tkinter import messagebox, simpledialog

# --- Dialog Class (Replacing the main app class) ---

class ActionManagerDialog(tk.Toplevel):
    """
    A Toplevel window designed to function as a modal dialog 
    for managing action objects.
    """
    def __init__(self, master, initial_actions=None):
        # Initialize the Toplevel window
        super().__init__(master)
        
        self.title("Action Code Manager (Dialog)")
        self.transient(master) # Set the main window as the dialog's parent
        self.protocol("WM_DELETE_WINDOW", self.on_close) # Handle window close

        # Dictionary to store actions: {action_id: code_implementation}
        self.actions = initial_actions if initial_actions is not None else {
            "Action_A": "print('This is Action A code.')",
            "Action_B": "def calculate_sum(a, b):\n    return a + b\n\nresult = calculate_sum(5, 10)\nprint(f'Sum: {result}')",
            "Action_C": "import time\nprint(f'Current time: {time.ctime()}')"
        }

        # Variable to hold the ID of the currently selected action
        self.current_action_id = tk.StringVar(value="None Selected")

        # Setup the GUI layout
        self.setup_layout()
        
        # Initial population of the ID list
        self.update_action_listbox()
        
        # Center the dialog and make it modal
        self.grab_set() # Grab all mouse and keyboard events
        self.master.wait_window(self) # Block execution until this window is destroyed

    def setup_layout(self):
        # --- Frames for organization ---
        
        # Frame for ID List and Buttons
        list_frame = tk.Frame(self, padx=10, pady=10)
        list_frame.pack(side=tk.LEFT, fill=tk.Y)

        # Frame for Code Display and Save Button
        code_frame = tk.Frame(self, padx=10, pady=10)
        code_frame.pack(side=tk.RIGHT, fill=tk.BOTH, expand=True)

        # --- Action ID List Box ---
        tk.Label(list_frame, text="Action IDs:", font=('Arial', 10, 'bold')).pack(anchor='w')
        
        list_scrollbar = tk.Scrollbar(list_frame, orient=tk.VERTICAL)
        
        self.action_listbox = tk.Listbox(
            list_frame, 
            height=15, 
            width=25, 
            yscrollcommand=list_scrollbar.set,
            exportselection=False
        )
        self.action_listbox.pack(side=tk.LEFT, fill=tk.Y)
        list_scrollbar.config(command=self.action_listbox.yview)
        list_scrollbar.pack(side=tk.LEFT, fill=tk.Y)
        
        self.action_listbox.bind('<<ListboxSelect>>', self.on_action_select)

        # --- Button Frame ---
        button_frame = tk.Frame(list_frame)
        button_frame.pack(pady=10)

        self.add_button = tk.Button(
            button_frame, 
            text="Add New Action", 
            command=self.add_action,
            width=20
        )
        self.add_button.pack(pady=5)

        self.remove_button = tk.Button(
            button_frame, 
            text="Remove Selected Action", 
            command=self.remove_action,
            width=20
        )
        self.remove_button.pack(pady=5)
        
        # A separate frame for the OK/Cancel buttons at the bottom of the dialog
        bottom_frame = tk.Frame(self, pady=10)
        bottom_frame.pack(fill=tk.X)
        tk.Button(bottom_frame, text="OK", command=self.on_ok, width=10).pack(side=tk.RIGHT, padx=5)
        tk.Button(bottom_frame, text="Cancel", command=self.on_close, width=10).pack(side=tk.RIGHT)


        # --- Code Display Text Box ---
        
        tk.Label(code_frame, textvariable=self.current_action_id, font=('Arial', 10, 'bold')).pack(anchor='w')
        
        code_scrollbar = tk.Scrollbar(code_frame, orient=tk.VERTICAL)
        
        self.code_text = tk.Text(
            code_frame, 
            wrap=tk.WORD, 
            height=20, 
            width=60, 
            yscrollcommand=code_scrollbar.set,
            font=('Consolas', 10)
        )
        self.code_text.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        code_scrollbar.config(command=self.code_text.yview)
        code_scrollbar.pack(side=tk.RIGHT, fill=tk.Y)
        
        # Button to save changes to the code
        save_button = tk.Button(
            code_frame, 
            text="Save Code Changes (to current action)", 
            command=self.save_code_changes
        )
        save_button.pack(fill=tk.X, pady=5)


    # --- Methods (same logic as before, but encapsulated in the dialog) ---

    def update_action_listbox(self):
        """Clears and repopulates the Listbox with all current action IDs."""
        self.action_listbox.delete(0, tk.END)
        for action_id in sorted(self.actions.keys()):
            self.action_listbox.insert(tk.END, action_id)

    def on_action_select(self, event):
        """Handles the event when an item is selected in the Listbox."""
        try:
            selected_indices = self.action_listbox.curselection()
            if not selected_indices:
                return 
            
            index = selected_indices[0]
            selected_id = self.action_listbox.get(index)
            
            self.current_action_id.set(f"Selected Action ID: {selected_id}")
            self.display_code(selected_id)

        except Exception as e:
            print(f"Error during selection: {e}")

    def display_code(self, action_id):
        """Prints the code of the given action_id to the Text widget."""
        code = self.actions.get(action_id, "ERROR: Code not found.")
        self.code_text.delete(1.0, tk.END)
        self.code_text.insert(tk.END, code)
        
    def save_code_changes(self):
        """Saves the current content of the Text widget back to the dictionary."""
        current_id_text = self.current_action_id.get()
        if "Selected Action ID: " not in current_id_text:
            messagebox.showerror("Error", "No action is currently selected to save.")
            return

        selected_id = current_id_text.replace("Selected Action ID: ", "")
        
        if selected_id not in self.actions:
            messagebox.showerror("Error", f"Action ID '{selected_id}' not found in dictionary.")
            return

        new_code = self.code_text.get(1.0, tk.END).strip()
        self.actions[selected_id] = new_code
        messagebox.showinfo("Success", f"Code for '{selected_id}' saved successfully.")

    def add_action(self):
        """Prompts the user for a new ID and adds a blank action."""
        new_id = simpledialog.askstring("Add New Action", "Enter a unique ID for the new action:", parent=self)
        
        if new_id:
            new_id = new_id.strip()
            if not new_id or new_id in self.actions:
                messagebox.showerror("Error", f"Invalid or duplicate Action ID: '{new_id}'.")
                return
            
            self.actions[new_id] = f"# Implementation for {new_id} goes here."
            self.update_action_listbox()
            
            # Select the new item
            self.action_listbox.selection_clear(0, tk.END)
            new_index = list(sorted(self.actions.keys())).index(new_id)
            self.action_listbox.selection_set(new_index)
            self.action_listbox.event_generate("<<ListboxSelect>>")

    def remove_action(self):
        """Removes the currently selected action."""
        try:
            selected_indices = self.action_listbox.curselection()
            if not selected_indices:
                messagebox.showwarning("Warning", "Please select an action to remove.")
                return

            index = selected_indices[0]
            selected_id = self.action_listbox.get(index)
            
            if messagebox.askyesno("Confirm Removal", f"Are you sure you want to remove action '{selected_id}'?", parent=self):
                del self.actions[selected_id]
                self.update_action_listbox()
                
                # Clear the display areas
                self.current_action_id.set("None Selected")
                self.code_text.delete(1.0, tk.END)
                messagebox.showinfo("Success", f"Action '{selected_id}' removed.")
                
        except Exception as e:
            messagebox.showerror("Error", f"An error occurred during removal: {e}")

    # --- Dialog Control Methods ---
    
    def on_ok(self):
        """Called when the OK button is pressed. Finalizes and closes the dialog."""
        # Optional: You could add a check here to ensure all code changes are saved
        # before allowing closure, but for now, we trust the user.
        self.result = self.actions # Set the final result to the modified dictionary
        self.destroy_dialog()

    def on_close(self):
        """Called on Cancel or window close. Discards changes and closes the dialog."""
        self.result = None # Indicate that no changes should be kept
        self.destroy_dialog()

    def destroy_dialog(self):
        """Cleanup and close the dialog window."""
        self.grab_release() # Release the event grab
        self.destroy()


# --- Main Application to Test the Dialog ---

class MainApplication(tk.Frame):
    def __init__(self, master):
        super().__init__(master)
        self.master.title("Main Application Window")
        self.pack(padx=20, pady=20)
        
        self.current_actions = {} # This will store the data from the dialog

        tk.Label(self, text="Action Manager Dialog Demo", font=('Arial', 12, 'bold')).pack(pady=10)
        
        self.open_button = tk.Button(
            self, 
            text="Open Action Manager Dialog", 
            command=self.open_manager
        )
        self.open_button.pack(pady=10)

        self.status_label = tk.Label(self, text="No actions loaded yet.", justify=tk.LEFT)
        self.status_label.pack(pady=10)

    def open_manager(self):
        """Opens the modal Action Manager Dialog."""
        
        # Pass the current action data to the dialog
        dialog = ActionManagerDialog(self.master, initial_actions=self.current_actions)
        
        # The code will block here until the dialog is closed
        
        # Check the result after the dialog is closed
        if dialog.result is not None:
            self.current_actions = dialog.result
            self.update_status()
            messagebox.showinfo("Result", f"Loaded {len(self.current_actions)} actions from dialog.")
        else:
            messagebox.showinfo("Result", "Dialog was cancelled. Actions were not updated.")

    def update_status(self):
        """Update the status label to show the current action data."""
        if self.current_actions:
            action_list = "\n".join(sorted(self.current_actions.keys()))
            self.status_label.config(
                text=f"Loaded Actions ({len(self.current_actions)}):\n{action_list}"
            )
        else:
            self.status_label.config(text="No actions loaded.")


# --- Execution ---
if __name__ == "__main__":
    root = tk.Tk()
    app = MainApplication(root)
    root.mainloop()