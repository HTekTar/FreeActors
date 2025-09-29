import tkinter as tk
from tkinter import simpledialog, messagebox, ttk
import json

# from hsm_parser import State
# from hsm_parser import Transition

# top_state = State(id="Top", super_state=None)

class RectangleDialog(tk.Toplevel):
    """
    A custom dialog box for entering rectangle dimensions and state properties.
    """
    def __init__(self, parent, state_ids):
        super().__init__(parent)
        self.transient(parent)
        self.grab_set()
        self.title("Enter State Properties")
        self.result = None

        tk.Label(self, text="Width:").grid(row=0, column=0, padx=5, pady=5)
        self.width_entry = tk.Entry(self)
        self.width_entry.grid(row=0, column=1, padx=5, pady=5)
        self.width_entry.insert(0, "200")
        
        tk.Label(self, text="Height:").grid(row=1, column=0, padx=5, pady=5)
        self.height_entry = tk.Entry(self)
        self.height_entry.grid(row=1, column=1, padx=5, pady=5)
        self.height_entry.insert(0, "150")

        tk.Label(self, text="State ID:").grid(row=2, column=0, padx=5, pady=5)
        self.id_entry = tk.Entry(self)
        self.id_entry.grid(row=2, column=1, padx=5, pady=5)
        
        tk.Label(self, text="Super State:").grid(row=3, column=0, padx=5, pady=5)
        state_ids.insert(0, "Top");
        self.super_combo = ttk.Combobox(self, values=state_ids)
        self.super_combo.grid(row=3, column=1, padx=5, pady=5)
        self.super_combo.current(0)
        
        submit_button = tk.Button(self, text="Draw State", command=self.on_submit)
        submit_button.grid(row=4, columnspan=2, pady=10)
        
        self.id_entry.focus_set()
        
        self.wait_window(self)

    def on_submit(self):
        """Handles the submission of the form."""
        try:
            width = int(self.width_entry.get())
            height = int(self.height_entry.get())
            state_id = self.id_entry.get()
            super_state = self.super_combo.get()
            
            if not state_id:
                messagebox.showerror("Error", "State ID cannot be empty.", parent=self)
                return

            if width > 0 and height > 0:
                self.result = (width, height, state_id, super_state)
                self.destroy()
            else:
                messagebox.showerror("Error", "Dimensions must be positive integers.", parent=self)
        except ValueError:
            messagebox.showerror("Error", "Invalid input. Please enter integers for dimensions.", parent=self)

class TransitionDialog(tk.Toplevel):
    """
    A custom dialog box for entering transition properties.
    """
    def __init__(self, parent):
        super().__init__(parent)
        self.transient(parent)
        self.grab_set()
        self.title("Enter Transition Properties")
        self.result = None

        tk.Label(self, text="Transition ID:").grid(row=0, column=0, padx=5, pady=5)
        self.id_entry = tk.Entry(self)
        self.id_entry.grid(row=0, column=1, padx=5, pady=5)
        
        tk.Label(self, text="Signal:").grid(row=1, column=0, padx=5, pady=5)
        self.sig_entry = tk.Entry(self)
        self.sig_entry.grid(row=1, column=1, padx=5, pady=5)

        tk.Label(self, text="Action:").grid(row=2, column=0, padx=5, pady=5)
        self.action_entry = tk.Entry(self)
        self.action_entry.grid(row=2, column=1, padx=5, pady=5)
        
        submit_button = tk.Button(self, text="Draw Transition", command=self.on_submit)
        submit_button.grid(row=3, columnspan=2, pady=10)
        
        self.id_entry.focus_set()
        
        self.wait_window(self)
    
    def on_submit(self):
        """Handles the submission of the form."""
        t_id = self.id_entry.get()
        sig = self.sig_entry.get()
        action = self.action_entry.get()

        if not t_id or not sig:
            messagebox.showerror("Error", "ID and Signal are required.", parent=self)
            return

        self.result = {'id': t_id, 'sig': sig, 'action': action if action else None}
        self.destroy()

class StateDiagram:
    def __init__(self, id, x, y):
        self.state_id = id
        self.children = []
        self.x = x
        self.y = y
        self.rect = None
        self.title_rect = None
        self.title_text = None
    def add_child(self, child):
        self.children.append(child)
    def get_rect(self):
        return self.rect
    def draw(self, canvas, x=None, y=None):
        if x is not None:
            self.x = x
        if y is not None:
            self.y = y
        if self.rect != None:
            canvas.delete(self.rect)
        if self.title_rect != None:
            canvas.delete(self.title_rect)
        if self.title_text != None:
            canvas.delete(self.title_text)
        cx = self.x + 20
        cy = self.y + 120
        width = 0
        height = 0
        for child in self.children:
            w, h = child.draw(canvas, cx, cy)
            cx += w + 20
            width += w + 20
            if h > height:
                height = h
        height += 150
        if width == 0:
            width = 200
        else:
            width += 20
        self.rect = canvas.create_rectangle(
            self.x, self.y,
            self.x + width, self.y + height,
            outline="black", width=4, tags="state_rectangle"
        )
        padx = 5
        pady = 5
        title_height = 25
        title_x1 = self.x+padx
        title_y1 = self.y+pady
        title_x2 = self.x+width-padx
        title_y2 = self.y+title_height
        self.title_rect = canvas.create_rectangle(title_x1, title_y1, title_x2, title_y2,fill="light green", outline="")
        title_text_x = (title_x1 + title_x2) / 2
        title_text_y = (title_y1 + title_y2) / 2
        self.title_text = canvas.create_text(title_text_x, title_text_y, text=self.state_id, fill="black", font=("Arial", 12, "bold"))
        return width, height

class TransitionDiagram:
    def __init__(self, points):
        self.coords = [(points[i], points[i+1]) for i in range(0, len(points), 2)]
        remove = []
        prev = False
        curr = False
        for i in range(1, len(self.coords)):
            curr = self.coords[i-1][0] == self.coords[i][0]
            if i > 1 and (prev == curr):
                remove.append(i-1-len(remove))
            prev = curr
        print(self.coords)
        print(remove)
        for i in range (0, len(remove)):
            self.coords.pop(remove[i])
        print(self.coords)


class StateMachineDiagrammer:
    """
    A simple application to draw a state machine diagram and export it to JSON.
    """
    def __init__(self, master):
        self.master = master
        master.title("State Machine Diagrammer")

        # Create a frame for the canvas and status bar
        main_frame = tk.Frame(master)
        main_frame.pack(fill=tk.BOTH, expand=True)

        self.canvas = tk.Canvas(main_frame, width=800, height=600, bg="white")
        self.canvas.pack(fill=tk.BOTH, expand=True)

        # Status bar to provide user feedback
        self.status_label = tk.Label(master, text="Ready", bd=1, relief=tk.SUNKEN, anchor=tk.W)
        self.status_label.pack(side=tk.BOTTOM, fill=tk.X)

        # Export button
        self.export_button = tk.Button(master, text="Export to JSON", command=self.export_to_json)
        self.export_button.pack(side=tk.BOTTOM, fill=tk.X)
        
        # Bind mouse events to their respective handlers
        self.canvas.bind("<Button-1>", self.on_left_click)
        self.canvas.bind("<Button-3>", self.on_right_click)
        self.canvas.bind("<Motion>", self.on_mouse_move)
        
        self.click_x = 0
        self.click_y = 0

        # State management for arrow drawing
        self.arrow_drawing_state = "idle"
        self.first_shape_id = None
        self.temp_arrow_id = None
        self.curve_points = []
        
        # State management for hover effect and colors
        self.last_hovered_item_id = None
        
        # Store all state and transition data
        self.states = {}
        self.transitions = {}
        self.state_diagrams = {}
        self.transition_diagrams = []

        self.context_menu = tk.Menu(master, tearoff=0)
        self.context_menu.add_command(label="Draw State (Rectangle)", command=self.show_rectangle_dialog)
        self.context_menu.add_command(label="Draw Transition (Arrow)", command=self.start_arrow_drawing)

    def on_mouse_move(self, event):
        """
        Handles mouse movement to create a hover effect on rectangles and
        to draw a temporary arrow.
        """

        item_id, x_int, y_int = self.hovered_over_state(event.x, event.y)
        if item_id:
            self.canvas.itemconfig(self.last_hovered_item_id, outline="black")
            self.canvas.itemconfig(item_id, outline="blue")
            self.last_hovered_item_id = item_id
        else:
            if self.last_hovered_item_id is not None:
                self.canvas.itemconfig(self.last_hovered_item_id, outline="black")
                self.last_hovered_item_id = None

        if self.arrow_drawing_state == "drawing_points":
            if self.temp_arrow_id:
                coords = self.canvas.coords(self.first_shape_id)
                
                dx = abs(self.curve_points[-2]-event.x)
                dy = abs(self.curve_points[-1]-event.y)
                new_point = []
                if dx > 10 and dy > 10:
                    if dx > dy:
                        all_points = self.curve_points + [event.x, self.curve_points[-1], event.x, event.y]
                    else:
                        all_points = self.curve_points + [self.curve_points[-2], event.y, event.x, event.y]
                elif dx > 10:
                    all_points = self.curve_points + [event.x, self.curve_points[-1]]
                elif dy > 10:
                    all_points = self.curve_points + [self.curve_points[-2], event.y]
                else:
                    all_points = self.curve_points
                self.arrow_tip_x = all_points[-2]
                self.arrow_tip_y = all_points[-1]
                self.canvas.coords(self.temp_arrow_id, all_points)
        
    def on_left_click(self, event):
        """
        Handles left-click events on the canvas, used for arrow drawing.
        """
        if self.arrow_drawing_state == "selecting_start":
            item_id, x1, y1 = self.hovered_over_state(event.x, event.y)
            if item_id:
                self.first_shape_id = item_id
                self.curve_points.append(x1)
                self.curve_points.append(y1)
                self.temp_arrow_id = self.canvas.create_line(x1, y1, event.x, event.y, arrow=tk.LAST, fill="purple", width=3)
                self.arrow_drawing_state = "drawing_points"
                self.status_label.config(text="Click to add curve points, then click another rectangle to finish.")
        elif self.arrow_drawing_state == "drawing_points":
            second_shape_id, x2, y2 = self.hovered_over_state(self.arrow_tip_x, self.arrow_tip_y)
            
            if second_shape_id:
                dx = abs(self.curve_points[-2]-x2)
                dy = abs(self.curve_points[-1]-y2)
                if dx == 0 or dy == 0:
                    self.curve_points += [x2, y2]
                elif dx > dy:
                    self.curve_points +=[x2, self.curve_points[-1], x2, y2]
                else:
                    self.curve_points += [self.curve_points[-2], y2, x2, y2]
                self.canvas.delete(self.temp_arrow_id)
                self.draw_curved_arrow(self.first_shape_id, second_shape_id)
                tran_diag = TransitionDiagram(self.curve_points)
                self.transition_diagrams.append(tran_diag)
                self.reset_arrow_state()
            else:
                dx = abs(self.curve_points[-2]-event.x)
                dy = abs(self.curve_points[-1]-event.y)
                if dx == 0 or dy == 0:
                    self.curve_points += [event.x, event.y]
                elif dx > dy:
                    self.curve_points +=[event.x, self.curve_points[-1], event.x, event.y]
                else:
                    self.curve_points += [self.curve_points[-2], event.y, event.x, event.y]
        else:
            self.click_x = event.x
            self.click_y = event.y

    def on_right_click(self, event):
        """
        Displays the context menu at the mouse cursor's position.
        """
        self.click_x = event.x
        self.click_y = event.y
        
        try:
            self.context_menu.tk_popup(event.x_root, event.y_root)
        finally:
            self.context_menu.grab_release()

    def start_arrow_drawing(self):
        """
        Initiates the arrow drawing process.
        """
        self.arrow_drawing_state = "selecting_start"
        self.status_label.config(text="Arrow mode: Click the first rectangle.")
        self.canvas.config(cursor="cross")
        
    def reset_arrow_state(self):
        """
        Resets the arrow drawing state and status message.
        """
        self.arrow_drawing_state = "idle"
        self.first_shape_id = None
        self.temp_arrow_id = None
        self.curve_points = []
        self.status_label.config(text="Ready")
        self.canvas.config(cursor="arrow")
        
    def draw_curved_arrow(self, start_item, end_item):
        """
        Draws a curved arrow between the edges of two rectangle shapes, using stored curve points.
        """
        # dialog = TransitionDialog(self.master)
        # if not dialog.result:
        #     self.reset_arrow_state()
        #     return
        
        arrow_id = self.canvas.create_line(
            self.curve_points, 
            arrow=tk.LAST, fill="purple", width=3
        )
        
        # Store transition data
        # transition_data = dialog.result
        # transition_data['target'] = self.states[end_item]['id']
        # self.transitions[arrow_id] = transition_data
        
        # Add transition ID to the starting state
        # if 'transitions' not in self.states[start_item]:
        #     self.states[start_item]['transitions'] = []
        # self.states[start_item]['transitions'].append(transition_data['id'])
        
        # Add a text label for the transition
        # transition_label = f"{transition_data['sig']}\n{transition_data['action'] or ''}"
        
        # mid_point_index = len(final_points) // 2
        # mid_x = final_points[mid_point_index - 1]
        # mid_y = final_points[mid_point_index]

        # self.canvas.create_text(mid_x, mid_y, text=transition_label, fill="black", font=("Arial", 10), tags=("transition_label",))
        
    # def _get_edge_point(self, rect_coords, other_point):
    #     """
    #     Calculates the point on the edge of a rectangle that a line from another point intersects.
    #     """
    #     x1, y1, x2, y2 = rect_coords
    #     cx = (x1 + x2) / 2
    #     cy = (y1 + y2) / 2
        
    #     dx = other_point[0] - cx
    #     dy = other_point[1] - cy

    #     if dx == 0 and dy == 0:
    #         return (cx, cy)
        
    #     if abs(dx) > abs(dy):
    #         t = (x1 - cx) / dx if dx < 0 else (x2 - cx) / dx
    #         x_int = cx + t * dx
    #         y_int = cy + t * dy
    #         return (x_int, y_int)
    #     else:
    #         t = (y1 - cy) / dy if dy < 0 else (y2 - cy) / dy
    #         x_int = cx + t * dx
    #         y_int = cy + t * dy
    #         return (x_int, y_int)
        
    def show_rectangle_dialog(self):
        """Opens a custom dialog for the user to enter both width and height."""
        state_ids = [state_data['id'] for state_data in self.states.values()]
        dialog = RectangleDialog(self.master, state_ids)
        if dialog.result:
            width, height, state_id, super_state = dialog.result
            self.draw_rectangle(state_id, super_state)
        
    def draw_rectangle(self, state_id, super_state):
        """
        Draws a rectangle on the canvas and stores its state data.
        """
        state_diagram = StateDiagram(id=state_id, x=self.click_x, y=self.click_y)
        self.state_diagrams[state_id] = state_diagram
        if super_state == "Top":
            state_diagram.draw(self.canvas)
        else:
            ss = self.states[super_state]
            self.state_diagrams[ss["id"]].add_child(state_diagram)
            while ss["super"] != "Top":
                ss = self.states[ss["super"]]
            self.state_diagrams[ss["id"]].draw(self.canvas)
        self.states[state_id] = {'id': state_id, 'super': super_state, 'transitions': []}

    def hovered_over_state(self, x, y):
        for diag in self.state_diagrams.values():
            rect = diag.rect
            x1, y1, x2, y2 = self.canvas.coords(rect)
            dy2 = abs(y-y2)
            dy1 = abs(y-y1)
            dx1 = abs(x-x1)
            dx2 = abs(x-x2)
            dy = dy1 if dy1<dy2 else dy2
            dx = dx1 if dx1<dx2 else dx2
            if (x1 < x < x2) and dy < 5:
                y_int = y1 if dy1<dy2 else y2
                x_int = x
                return rect, x_int, y_int
                break
            elif (y1<y<y2) and dx<5:
                x_int = x1 if dx1<dx2 else x2
                y_int = y
                return rect, x_int, y_int
        return None, 0, 0
        
        

    def export_to_json(self):
        """
        Exports the current diagram's data to a JSON object.
        """
        states_list = []
        for state_data in self.states.values():
            state_obj = {
                "id": state_data['id'],
                "super": state_data['super'],
                "transitions": state_data['transitions']
            }
            states_list.append(state_obj)

        transitions_list = []
        for transition_data in self.transitions.values():
            transition_obj = {
                "id": transition_data['id'],
                "sig": transition_data['sig'],
                "target": transition_data['target']
            }
            if transition_data['action']:
                transition_obj["action"] = transition_data['action']
            transitions_list.append(transition_obj)
        
        final_json = {
            "states": states_list,
            "transitions": transitions_list
        }
        
        json_string = json.dumps(final_json, indent=4)
        
        # Display the JSON in a message box
        messagebox.showinfo("Exported JSON", json_string)
        
if __name__ == "__main__":
    root = tk.Tk()
    app = StateMachineDiagrammer(root)
    root.mainloop()
