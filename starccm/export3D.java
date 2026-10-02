// Exports the car's surfaces with Cp fields as EnSight Gold into 3D-data/ of the
// case folder, for HoMo CFD's 3D viewer. postprocessing.java plays it at the end;
// it can also be played on its own in STAR-CCM+ (File > Macro > Play Macro).
//
// Only wall boundaries of the car are exported (a full car is about 70 MB plus
// about 6 MB per field): the domain (inlet, outlet, floor, tunnel walls,
// symmetry) and interfaces are skipped, see SKIPPED. Fields a simulation does
// not have are left out. Problems are printed to the log and never stop the
// post-processing. Written for STAR-CCM+ 2506 (20.04).

import java.io.File;
import java.util.ArrayList;
import java.util.Locale;

import star.base.neo.NeoProperty;
import star.common.*;

public class export3D extends StarMacro {

    // Per-cell fields, as in the team's hand export of 0823_upsi.
    private static final String[] FIELDS = {"PressureCoefficient", "TotalPressureCoefficient", "CpX", "CpZ", "CpZCpX"};
    // Wall boundaries that belong to the wind tunnel, not to the car (compared ignoring case).
    private static final String[] SKIPPED = {"floor", "ground", "road", "walls", "wall", "tunnel", "symmetry", "sym", "top", "side"};

    @Override
    public void execute() {
        Simulation simulation = getActiveSimulation();
        try {
            ArrayList<Boundary> surfaces = new ArrayList<>();
            for (Region region : simulation.getRegionManager().getRegions()) {
                for (Boundary boundary : region.getBoundaryManager().getBoundaries()) {
                    if (boundary.getBoundaryType() instanceof WallBoundary && isCar(boundary.getPresentationName())) {
                        surfaces.add(boundary);
                    }
                }
            }
            ArrayList<FieldFunction> fields = new ArrayList<>();
            FieldFunctionManager functions = simulation.getFieldFunctionManager();
            for (String name : FIELDS) {
                if (functions.hasFunction(name)) {
                    fields.add(functions.getFunction(name));
                } else {
                    simulation.println("export3D: no field function " + name + ", left out");
                }
            }
            if (surfaces.isEmpty() || fields.isEmpty()) {
                simulation.println("export3D: nothing to export (" + surfaces.size() + " surfaces, " + fields.size() + " fields)");
                return;
            }
            File folder = new File(simulation.getSessionDir(), "3D-data");
            folder.mkdirs();
            String caseFile = new File(folder, simulation.getPresentationName() + ".case").getPath();
            // Boundaries only (no regions: those would add the whole volume mesh), values per cell.
            simulation.getImportManager().export(caseFile, new ArrayList<Region>(), surfaces, new ArrayList<Part>(),
                    new ArrayList<PartSurface>(), fields,
                    NeoProperty.fromString("{'exportFormatType': 2, 'appendToFile': false, 'solutionOnly': false, 'dataAtVerts': false}"));
            simulation.println("export3D: " + surfaces.size() + " surfaces with " + fields.size() + " fields written to " + caseFile);
        } catch (Exception e) {
            simulation.println("export3D failed, post-processing continues: " + e);
        }
    }

    private static boolean isCar(String name) {
        String lower = name.toLowerCase(Locale.ROOT).trim();
        if (lower.startsWith("internal") || lower.contains("interface") || lower.contains("[")) {
            return false;
        }
        for (String skipped : SKIPPED) {
            if (lower.equals(skipped)) {
                return false;
            }
        }
        return true;
    }
}
